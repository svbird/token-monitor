'use strict';

const crypto = require('node:crypto');

const TOKEN_FIELDS = ['total_input_tokens', 'total_output_tokens', 'total_cache_read_tokens', 'total_cache_creation_tokens', 'total_tokens'];
const DIMENSIONS = ['model_name', 'feature', 'subagent_type', 'business_sub_type', 'platform', 'source'];
const GROUP_DIMENSIONS = [...DIMENSIONS, 'first_create_date', 'first_create_time'];
const FIELDS = [...DIMENSIONS, 'first_create_time', ...TOKEN_FIELDS, 'total_credits'];
const ENDPOINT = 'https://api.verdent.ai/verdent/billing/credits_details';
const IDENTITY_ENDPOINT = 'https://login.verdent.ai/passport/inner/user/trackinfo';

class VerdentError extends Error {
  constructor(code, message, anomalies, options) { super(message, options); this.code = code; this.anomalies = anomalies; }
}

function fail(code, message, anomalies) { throw new VerdentError(code, message, anomalies); }

function calendarDay(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('range', '日期必须为 YYYY-MM-DD。');
  const utc = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== date) fail('range', '日期无效。');
  return utc;
}

function daySeconds(date) {
  calendarDay(date);
  return new Date(`${date}T00:00:00`).getTime() / 1000;
}

function shiftDay(date, count) {
  return new Date(calendarDay(date) + count * 86400000).toISOString().slice(0, 10);
}

function scopeForDates(startDate, endDate) {
  const start_time = daySeconds(startDate);
  const end_time = daySeconds(shiftDay(endDate, 1)) - 1;
  const days = (calendarDay(endDate) - calendarDay(startDate)) / 86400000 + 1;
  if (days < 1 || days > 366 || end_time < start_time) fail('range', '请选择不超过 366 天的日期范围。');
  return { team_id: '0', consume_type: '', startDate, endDate, start_time, end_time };
}

function historyScope(now = Date.now()) {
  const end_time = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(end_time) || end_time < 0) fail('range', '系统时间无效。');
  const end = new Date(end_time * 1000);
  const start = new Date(end.getFullYear(), end.getMonth() - 3, 1);
  // Calendar months, clamped at month end; local midnight follows the OS zone.
  const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  start.setDate(Math.min(end.getDate(), lastDay));
  const start_time = Math.max(0, start.getTime() / 1000);
  if (!Number.isSafeInteger(start_time)) fail('range', '系统时间无效。');
  return { kind: 'allHistory', team_id: '0', consume_type: '', startDate: firstCreateDay(start_time), endDate: firstCreateDay(end_time), start_time, end_time };
}

function scopeKey(scope) { return `${scope.kind === 'allHistory' ? 'all-history' : `${scope.start_time}/${scope.end_time}`}/${scope.team_id}/${scope.consume_type}`; }

function successfulBody(reply) {
  if (reply?.status === 401 || reply?.status === 403) fail('auth', 'Verdent 登录已失效，请重新登录。');
  if (!Number.isInteger(reply?.status) || reply.status < 200 || reply.status >= 300) fail('http', `Verdent HTTP ${Number.isInteger(reply?.status) ? reply.status : '异常'}，保留上次结果。`);
  const body = reply.body;
  if (!body || typeof body !== 'object' || !Number.isInteger(body.errCode)) fail('schema', 'Verdent 响应结构异常。');
  if (body.errCode === 401 || body.errCode === 403) fail('auth', 'Verdent 登录已失效，请重新登录。');
  // Never reflect errMsg or HTTP bodies: upstream errors can contain private data.
  if (body.errCode !== 0) fail('api', `Verdent 返回错误码 ${body.errCode}；可尝试重新登录。`);
  if (!body.data || typeof body.data !== 'object') fail('schema', 'Verdent data 缺失。');
  return body.data;
}

function accountKey(reply) {
  const data = successfulBody(reply);
  const id = data.user_id;
  if (!((typeof id === 'string' && id.trim() && id.length < 512) || (Number.isSafeInteger(id) && id > 0))) fail('identity', '未能验证 Verdent user_id，已停止采集以避免混合账号。');
  return crypto.createHash('sha256').update(`verdent:${id}`).digest('hex');
}

function parseItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail('schema', `第 ${index + 1} 条记录格式异常。`);
  const row = {};
  for (const field of DIMENSIONS) {
    if (typeof item[field] !== 'string' || item[field].length > 512) fail('schema', `第 ${index + 1} 条记录 ${field} 异常。`);
    row[field] = item[field];
  }
  for (const field of [...TOKEN_FIELDS, 'first_create_time']) {
    if (!Number.isSafeInteger(item[field]) || item[field] < 0) fail('schema', `第 ${index + 1} 条记录 ${field} 异常。`);
    row[field] = item[field];
  }
  if (!Number.isFinite(item.total_credits) || item.total_credits < 0) fail('schema', `第 ${index + 1} 条记录 total_credits 异常。`);
  row.total_credits = item.total_credits;
  if (!Number.isFinite(new Date(row.first_create_time * 1000).getTime())) fail('schema', `第 ${index + 1} 条记录 first_create_time 超出日期范围。`);
  return row;
}

function firstCreateDay(seconds) {
  const date = new Date(seconds * 1000);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function summarize(items) {
  const totals = Object.fromEntries([...TOKEN_FIELDS, 'total_credits'].map(field => [field, 0]));
  for (const item of items) for (const field of Object.keys(totals)) {
    totals[field] += item[field];
    if (!Number.isFinite(totals[field]) || (field !== 'total_credits' && !Number.isSafeInteger(totals[field]))) fail('schema', '用量合计超出安全数值范围。');
  }
  return totals;
}

function modelLabel(item) { return `${item.model_name}${item.business_sub_type === 'eco_mode' ? '[eco]' : ''}`; }

function groupItems(items, dimension) {
  if (!GROUP_DIMENSIONS.includes(dimension)) fail('schema', '未知分组。');
  const groups = new Map();
  for (const row of items) {
    const key = dimension === 'model_name' ? modelLabel(row) : dimension === 'first_create_date' ? firstCreateDay(row.first_create_time) : String(row[dimension]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Array.from(groups, ([name, rows]) => ({ name, items: rows.length, ...summarize(rows) }))
    .sort((a, b) => dimension === 'first_create_date' ? b.name.localeCompare(a.name)
      : dimension === 'first_create_time' ? Number(b.name) - Number(a.name) : b.total_tokens - a.total_tokens);
}

// Sorted rows preserve multiplicity. This is a comparison, never a deduplicator.
function fingerprint(items) {
  return crypto.createHash('sha256').update(JSON.stringify(items.map(row => FIELDS.map(field => row[field])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex');
}

function compareSnapshots(previous, next) {
  if (!previous) return null;
  const counts = new Map();
  for (const row of previous.items) {
    const key = JSON.stringify(FIELDS.map(field => row[field]));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let addedOccurrences = 0;
  for (const row of next.items) {
    const key = JSON.stringify(FIELDS.map(field => row[field]));
    if (counts.get(key)) counts.set(key, counts.get(key) - 1);
    else addedOccurrences++;
  }
  const removedOccurrences = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  return { previousUpdatedAt: previous.updatedAt, unchanged: previous.fingerprint === next.fingerprint,
    previousRecords: previous.total, currentRecords: next.total, addedOccurrences, removedOccurrences,
    deltas: Object.fromEntries([...TOKEN_FIELDS, 'total_credits'].map(field => [field, next.totals[field] - previous.totals[field]])) };
}

const FULL_RECHECK_MS = 24 * 3600000;
const MATCH_ROWS = 20;
const descending = items => items.every((row, index) => !index || row.first_create_time <= items[index - 1].first_create_time);

function reusableCheckpoint(previous, scope, key, now) {
  const fullReadAt = previous?.fullReadAt || (previous?.consistency === 'two-equal-reads' ? previous.updatedAt : null);
  const age = Date.parse(now) - Date.parse(fullReadAt);
  if (!previous || previous.accountKey !== key || !Number.isFinite(age) || age < 0 || (scope.kind !== 'allHistory' && age >= FULL_RECHECK_MS)
    || previous.scope.start_time > scope.start_time || previous.scope.end_time > scope.end_time
    || !descending(previous.items) || previous.items.some(row => row.first_create_time < previous.scope.start_time || row.first_create_time > previous.scope.end_time)) return null;
  const items = previous.items.filter(row => row.first_create_time >= scope.start_time && row.first_create_time <= scope.end_time);
  if (items.length <= MATCH_ROWS) return null;
  return { items, fullReadAt, watermark: items[0].first_create_time };
}

async function collectPass({ request, scope, signal, pause, progress, checkpoint }) {
  const items = [];
  let total;
  let pageSize;
  let pageCount = 1;
  let pagesRead = 0; let reusedRecords = 0;
  for (let page = 1; page <= pageCount; page++) {
    signal?.throwIfAborted();
    if (page > 1) await pause(350, signal);
    const data = successfulBody(await request(ENDPOINT, { team_id: '0', consume_type: '', start_time: scope.start_time, end_time: scope.end_time, page, page_size: 10 }, signal));
    if (!Number.isSafeInteger(data.total) || data.total < 0 || data.total > 100000 || data.page !== page || data.page_size !== 10 || !Array.isArray(data.items)) fail('pagination', '分页结构、页码或分页大小异常。');
    if (page === 1) { total = data.total; pageSize = data.page_size; pageCount = Math.max(1, Math.ceil(total / pageSize)); }
    if (data.total !== total || data.page_size !== pageSize) fail('drift', '采集期间 total 或 page_size 变化，需要重试。');
    const expected = Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize));
    if (data.items.length !== expected) fail('pagination', '分页不完整，已保留上次结果。');
    for (const item of data.items) items.push(parseItem(item, items.length));
    pagesRead = page;
    progress?.({ page, pages: pageCount, total });
    if (checkpoint && page < pageCount && items.length >= MATCH_ROWS && total >= checkpoint.items.length && descending(items)) {
      // A count-aligned, exact multiset anchor is stronger than a timestamp or ID.
      // Never splice through a same-second group; keep every duplicate occurrence.
      const cachedEnd = items.length - (total - checkpoint.items.length);
      const lastTime = items.at(-1).first_create_time;
      if (cachedEnd >= MATCH_ROWS && cachedEnd < checkpoint.items.length
        && lastTime < checkpoint.watermark && lastTime > checkpoint.items[cachedEnd].first_create_time
        && fingerprint(items.slice(-MATCH_ROWS)) === fingerprint(checkpoint.items.slice(cachedEnd - MATCH_ROWS, cachedEnd))) {
        const tail = checkpoint.items.slice(cachedEnd);
        reusedRecords = tail.length;
        items.push(...tail);
        progress?.({ page, pages: pageCount, total, reusedRecords });
        break;
      }
    }
  }
  if (items.length !== total) fail('pagination', '记录总数与 total 不一致。');
  const anomalies = items.filter(row => row.total_tokens !== row.total_input_tokens + row.total_output_tokens + row.total_cache_read_tokens + row.total_cache_creation_tokens);
  if (anomalies.length) fail('components', `${anomalies.length} 条记录的 Token 分类与原始总量不一致；原字段已保留供检查，未覆盖成功快照。`, anomalies);
  return { items, total, pages: pageCount, pagesRead, reusedRecords, fingerprint: fingerprint(items), totals: summarize(items) };
}

async function collectSnapshot({ request, startDate, endDate, kind, end_time, signal, pause = async (ms, signal) => require('node:timers/promises').setTimeout(ms, undefined, { signal }), progress, previous, forceFull = false, now = () => new Date().toISOString() }) {
  const scope = kind === 'allHistory' ? historyScope(end_time * 1000) : scopeForDates(startDate, endDate);
  const key = accountKey(await request(IDENTITY_ENDPOINT, null, signal));
  const startedAt = now();
  let checkpoint = forceFull ? null : reusableCheckpoint(previous, scope, key, startedAt);
  // Equal reads detect changes in the fetched prefix. Cached tails are revisited
  // by an explicit full check; this API cannot prove an untouched historical tail.
  // The API still offers no transactional snapshot guarantee.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const first = await collectPass({ request, scope, signal, pause, checkpoint, progress: p => progress?.({ ...p, pass: 1, attempt: attempt + 1 }) });
      await pause(750, signal);
      const second = await collectPass({ request, scope, signal, pause, checkpoint, progress: p => progress?.({ ...p, pass: 2, attempt: attempt + 1 }) });
      if (key !== accountKey(await request(IDENTITY_ENDPOINT, null, signal))) fail('accountChanged', '采集期间账号发生变化，已取消本次结果。');
      if (first.fingerprint !== second.fingerprint || first.total !== second.total) fail('drift', '两轮读取结果不同，需要完整重试。');
      const reused = first.reusedRecords > 0 || second.reusedRecords > 0;
      const updatedAt = now();
      return { scope, accountKey: key, ...second, updatedAt, fullReadAt: reused ? checkpoint.fullReadAt : updatedAt,
        consistency: reused ? 'two-matching-prefixes-cached-tail' : 'two-equal-reads' };
    } catch (error) {
      if (error.code !== 'drift' || attempt === 1) throw error;
      checkpoint = null;
      await pause(1000, signal);
    }
  }
}

module.exports = { ENDPOINT, IDENTITY_ENDPOINT, FIELDS, DIMENSIONS, GROUP_DIMENSIONS, TOKEN_FIELDS, VerdentError, scopeForDates, historyScope, scopeKey, shiftDay, successfulBody, accountKey, parseItem, summarize, groupItems, modelLabel, firstCreateDay, fingerprint, compareSnapshots, collectSnapshot };
