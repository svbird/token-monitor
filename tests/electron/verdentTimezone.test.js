'use strict';

const test = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

function inZone(timezone, code) {
  execFileSync(process.execPath, ['-e', code], {
    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8',
    env: { ...process.env, TZ: timezone }, timeout: 20000,
  });
}

for (const timezone of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Kathmandu']) {
  test(`Verdent query, grouping and periods follow the system timezone (${timezone})`, () => inZone(timezone, `
    const assert = require('node:assert/strict');
    const { scopeForDates, firstCreateDay } = require('./src/electron/providers/verdent/usage');
    const { bounds } = require('./src/electron/providers/verdent/presentation');
    const scope = scopeForDates('2026-10-10', '2026-10-16');
    assert.equal(scope.start_time, new Date(2026, 9, 10).getTime() / 1000);
    assert.equal(scope.end_time, new Date(2026, 9, 17).getTime() / 1000 - 1);
    assert.equal(Object.hasOwn(scope, 'timezone'), false);
    const midnight = new Date(2026, 9, 16).getTime();
    assert.equal(firstCreateDay(midnight / 1000 - 1), '2026-10-15');
    assert.equal(firstCreateDay(midnight / 1000), '2026-10-16');
    assert.deepEqual(bounds('today', midnight), { start: '2026-10-16', end: '2026-10-16' });
  `));
}

test('DST dates have 23/25 hours and history includes both repeated-clock records', () => inZone('America/New_York', `
  const assert = require('node:assert/strict');
  const { scopeForDates, shiftDay, IDENTITY_ENDPOINT } = require('./src/electron/providers/verdent/usage');
  const { projectHistory } = require('./src/electron/providers/verdent/history');
  const { VerdentController } = require('./src/electron/providers/verdent/controller');
  for (const [date, hours] of [['2026-03-08', 23], ['2026-11-01', 25]]) {
    const scope = scopeForDates(date, date);
    assert.equal(scope.end_time - scope.start_time + 1, hours * 3600);
  }
  const scope = scopeForDates('2026-10-31', '2026-11-02');
  const item = first_create_time => ({ first_create_time, model_name: 'test', total_tokens: 1, total_input_tokens: 1, total_output_tokens: 0, total_cache_read_tokens: 0, total_cache_creation_tokens: 0, total_credits: 0 });
  const times = ['2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-05:00', '2026-11-02T23:59:59-05:00'];
  const usage = projectHistory([{ profileId: 'p', accountKey: 'a', scope, updatedAt: '2026-11-03T00:00:00Z', items: times.map(t => item(Date.parse(t) / 1000)) }], 'p');
  assert.deepEqual(usage.daily.map(d => d.tokens), [0, 2, 1]);
  assert.equal(usage.coverage.partialDays, 0);
  const week = scopeForDates('2026-03-02', '2026-03-08');
  assert.equal(shiftDay(week.startDate, 6), week.endDate);
  const request = async (url, body) => ({ status: 200, body: { errCode: 0, data: url === IDENTITY_ENDPOINT ? { user_id: 'synthetic' } : { page: body.page, page_size: 10, total: 0, items: [] } } });
  const store = { data: { enabled: false, profiles: [{ id: 'p', label: 'Test' }], activeProfile: 'p', snapshots: [], rangeMode: 'fixed', range: week, intervalMinutes: 0 } };
  const controller = new VerdentController({ store, browserFactory: () => ({ request, close() {} }) });
  store.data.enabled = true;
  controller.options = () => ({ ...week, request, pause: async () => {} });
  controller.selectHistory(week);
  (async () => {
    try {
      const result = await controller.validateWeek();
      assert.equal(result.error, null);
      assert.equal(result.validation.daily.length, 7);
      assert.equal(result.validation.sumsMatch, true);
    } finally { controller.dispose(); }
  })().catch(e => { console.error(e); process.exitCode = 1; });
`));

test('timezone changes preserve saved query epochs, invalidate views and overlay shifted intervals once', () => inZone('UTC', `
  const assert = require('node:assert/strict');
  const { scopeForDates, scopeKey } = require('./src/electron/providers/verdent/usage');
  const { VerdentStore } = require('./src/electron/providers/verdent/store');
  const { VerdentController } = require('./src/electron/providers/verdent/controller');
  const { projectHistory } = require('./src/electron/providers/verdent/history');
  const id = '11111111-1111-1111-1111-111111111111';
  const row = (time, tokens) => ({ first_create_time: Date.parse(time) / 1000, model_name: 'test', feature: 'test', subagent_type: '', business_sub_type: '', platform: 'Verdent', source: 'verdent', total_tokens: tokens, total_input_tokens: tokens, total_output_tokens: 0, total_cache_read_tokens: 0, total_cache_creation_tokens: 0, total_credits: 0 });
  const old = { profileId: id, accountKey: 'a'.repeat(64), scope: scopeForDates('2026-10-16', '2026-10-16'), items: [row('2026-10-16T01:00:00Z', 10), row('2026-10-16T12:00:00Z', 20)], total: 2, updatedAt: '2026-10-17T01:00:00Z' };
  const saved = { version: 1, enabled: true, intervalMinutes: 0, rangeMode: 'fixed', range: old.scope, activeProfile: id, profiles: [{ id, label: 'Test' }], snapshots: [old] };
  const store = new VerdentStore('unused', { read: () => JSON.stringify(saved), write: () => {} });
  const controller = new VerdentController({ store, now: () => Date.parse('2026-10-17T12:00:00Z') });
  try {
    controller.startupPending = false; clearTimeout(controller.timer);
    const before = controller.usage();
    assert.equal(before.daily.length, 1);
    process.env.TZ = 'America/New_York';
    const reloaded = new VerdentStore('unused', { read: () => JSON.stringify(saved), write: () => {} });
    assert.deepEqual(reloaded.data.snapshots[0].scope, old.scope);
    const after = controller.usage();
    assert.notEqual(after, before);
    assert.deepEqual(after.daily.map(d => d.tokens), [10, 20]);
    assert.equal(after.coverage.partialDays, 2);
    const current = controller.collectionRange();
    assert.notEqual(scopeKey(current), scopeKey(old.scope));
    controller.selectHistory({ key: scopeKey(old.scope) });
    assert.equal(controller.state().selected.total, 2);
    const newer = { ...old, scope: scopeForDates('2026-10-16', '2026-10-16'), items: [row('2026-10-16T12:00:00Z', 30), row('2026-10-17T02:00:00Z', 40)], updatedAt: '2026-10-17T02:00:00Z' };
    const merged = projectHistory([old, newer], id);
    assert.deepEqual(merged.daily.map(d => d.tokens), [10, 70]);
    assert.equal(merged.coverage.partialDays, 1);
    assert.deepEqual(projectHistory([old, newer, newer], id).daily, merged.daily);
  } finally { controller.dispose(); }
`));
