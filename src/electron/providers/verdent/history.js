'use strict';

const { createHash } = require('node:crypto');
const { firstCreateDay, modelLabel, scopeForDates, shiftDay } = require('./usage');
const { normalizeHistory, mergeHistories } = require('../../../shared/history');
const { projectPeriod } = require('./presentation');

function blank() { return { tokens: 0, credits: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; }
function add(target, item) {
  target.tokens += item.total_tokens; target.credits += item.total_credits;
  target.input += item.total_input_tokens; target.output += item.total_output_tokens;
  target.cacheRead += item.total_cache_read_tokens; target.cacheWrite += item.total_cache_creation_tokens;
}

// Attribute first_create_time using the current system timezone. Pick the newest
// snapshot per queried interval, including when timezone changes shift day edges.
// Identical items and same-second items retain every occurrence within that range.
function projectHistory(snapshots, profileId, accountKey) {
  const local = snapshots.filter(snapshot => snapshot.profileId === profileId);
  const account = accountKey || [...local].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.accountKey;
  if (!account) return null;
  const candidates = local.filter(snapshot => snapshot.accountKey === account).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  // The retention cutoff is not the account creation date. Start charts at the
  // earliest saved record, while preserving the full range as an overlap mask.
  let firstRecord = Infinity;
  for (const snapshot of candidates) for (const item of snapshot.items) {
    if (item.first_create_time >= snapshot.scope.start_time && item.first_create_time <= snapshot.scope.end_time) firstRecord = Math.min(firstRecord, item.first_create_time);
  }
  const days = new Map(); let excludedSnapshots = 0;
  const covered = [];
  for (const snapshot of [...candidates].reverse()) {
    // A record outside the queried range contradicts the chosen attribution.
    // Retain the original snapshot, but do not silently publish a partial total.
    if (snapshot.items.some(item => item.first_create_time < snapshot.scope.start_time || item.first_create_time > snapshot.scope.end_time)) { excludedSnapshots++; continue; }
    let segments = [[snapshot.scope.start_time, snapshot.scope.end_time]];
    for (const [left, right] of covered) {
      segments = segments.flatMap(([start, end]) => {
        if (right < start || left > end) return [[start, end]];
        return [...(start < left ? [[start, left - 1]] : []), ...(end > right ? [[right + 1, end]] : [])];
      });
    }
    for (const [start, end] of segments) {
      const chartStart = snapshot.scope.kind === 'allHistory' ? Math.max(start, scopeForDates(firstCreateDay(Number.isFinite(firstRecord) ? firstRecord : end), firstCreateDay(Number.isFinite(firstRecord) ? firstRecord : end)).start_time) : start;
      for (let date = firstCreateDay(chartStart); date <= firstCreateDay(end); date = shiftDay(date, 1)) {
        if (!days.has(date)) days.set(date, { date, ...blank(), models: Object.create(null), updatedAt: snapshot.updatedAt, coveredSeconds: 0 });
        const scope = scopeForDates(date, date);
        days.get(date).coveredSeconds += Math.max(0, Math.min(end, scope.end_time) - Math.max(start, scope.start_time) + 1);
      }
    }
    for (const item of snapshot.items) {
      if (!segments.some(([start, end]) => item.first_create_time >= start && item.first_create_time <= end)) continue;
      const daily = days.get(firstCreateDay(item.first_create_time));
      add(daily, item);
      const name = modelLabel(item);
      daily.models[name] ||= blank(); add(daily.models[name], item);
    }
    covered.push(...segments);
  }
  const daily = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const row of daily) {
    const scope = scopeForDates(row.date, row.date);
    row.complete = row.coveredSeconds === scope.end_time - scope.start_time + 1;
    delete row.coveredSeconds;
  }
  const revision = createHash('sha256').update(JSON.stringify([profileId, account, daily, excludedSnapshots])).digest('hex').slice(0, 20);
  return { account: account.slice(0, 10), daily, excludedSnapshots, revision, updatedAt: candidates.at(-1)?.updatedAt,
    coverage: daily.length ? { start: daily[0].date, end: daily.at(-1).date, days: daily.length, partialDays: daily.filter(row => !row.complete).length } : null };
}

function historyForDisplay(base, usage, now = Date.now()) {
  if (!usage?.daily.length || base?.verdentRevision === usage.revision) return base;
  const todayKey = firstCreateDay(now / 1000);
  const rows = usage.daily.filter(row => row.date <= todayKey);
  const contributions = rows.map(row => ({ date: row.date, tokens: row.tokens, cost: 0, cacheReadTokens: row.cacheRead, cacheWriteTokens: row.cacheWrite, outputTokens: row.output, unclassifiedTokens: 0, tokenComponentsAvailable: true,
    perClient: { verdent: { tokens: row.tokens, cost: 0, cacheReadTokens: row.cacheRead, cacheWriteTokens: row.cacheWrite, outputTokens: row.output, unclassifiedTokens: 0, tokenComponentsAvailable: true } },
    perModel: Object.fromEntries(Object.entries(row.models).map(([name, model]) => [name, { tokens: model.tokens, cost: 0, cacheReadTokens: model.cacheRead, cacheWriteTokens: model.cacheWrite, outputTokens: model.output, unclassifiedTokens: 0, tokenComponentsAvailable: true }])) }));
  const overlay = normalizeHistory({ contributions }, { todayKey, capDays: 100000 });
  const merged = mergeHistories([base, overlay], { todayKey, capDays: 100000 });
  const creditDays = new Map(rows.map(row => [row.date, row.credits]));
  const creditMonths = new Map();
  const modelCreditsByDate = new Map(rows.map(row => [row.date, Object.fromEntries(Object.entries(row.models).map(([name, value]) => [name, value.credits]))]));
  const attachDayCredits = row => {
    if (!creditDays.has(row.date)) return row;
    const credits = modelCreditsByDate.get(row.date);
    return { ...row, verdentCredits: creditDays.get(row.date),
      perClient: { ...row.perClient, verdent: { ...row.perClient.verdent, verdentCredits: creditDays.get(row.date) } },
      perModel: Object.fromEntries(Object.entries(row.perModel).map(([name, value]) => [name, Object.hasOwn(credits, name) ? { ...value, verdentCredits: credits[name] } : value])) };
  };
  for (const row of rows) creditMonths.set(row.date.slice(0, 7), (creditMonths.get(row.date.slice(0, 7)) || 0) + row.credits);
  return { ...base, ...merged, verdentRevision: usage.revision, verdent: usage,
    daily: merged.daily.map(attachDayCredits),
    monthly: merged.monthly.map(row => ({ ...row, ...(creditMonths.has(row.month) ? { verdentCredits: creditMonths.get(row.month) } : {}) })),
    summary: { ...base?.summary, ...merged.summary,
      totalTokens: Number(base?.summary?.totalTokens || 0) + overlay.summary.totalTokens,
      totalCost: Number(base?.summary?.totalCost || 0),
      messages: Number(base?.summary?.messages || 0), activeTimeMs: Number(base?.summary?.activeTimeMs || 0),
      verdentCredits: rows.reduce((sum, row) => sum + row.credits, 0) } };
}

function statsForDisplay(base, usage, now = Date.now()) {
  if (!base || !usage || base.verdentUsage?.revision === usage.revision) return base;
  return { ...base, periods: Object.fromEntries(Object.entries(base.periods || {}).map(([name, period]) => [name, projectPeriod(period, usage, name, now)])),
    verdentUsage: usage, historyRevision: `${base.historyRevision || ''}:verdent:${usage.revision}`,
    historyPreview: historyForDisplay(base.historyPreview, usage, now) };
}

module.exports = { projectHistory, historyForDisplay, statsForDisplay };
