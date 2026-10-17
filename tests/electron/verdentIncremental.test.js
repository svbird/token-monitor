'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { historyScope, collectSnapshot, IDENTITY_ENDPOINT, fingerprint, groupItems } = require('../../src/electron/providers/verdent/usage');
const { projectHistory, statsForDisplay, historyForDisplay } = require('../../src/electron/providers/verdent/history');
const { projectModelAliasStats, projectModelAliasHistory } = require('../../src/electron/modelAliasPresentation');
const NOW = new Date('2026-10-16T12:00:00').toISOString();
const range = { startDate: '2026-10-10', endDate: '2026-10-16' };
function row(i) { return { model_name: 'vendor/model', feature: 'Main Agent', platform: 'Verdent', source: 'verdent', business_sub_type: '', subagent_type: '', first_create_time: new Date('2026-10-16T09:00:02').getTime() / 1000 - i, total_input_tokens: 7, total_output_tokens: 1, total_cache_read_tokens: 2, total_cache_creation_tokens: 0, total_tokens: 10, total_credits: 0.5 }; }
function remote(items, id = 'account-a') {
  const calls = [];
  return { calls, request: async (url, body) => {
    if (url === IDENTITY_ENDPOINT) return { status: 200, body: { errCode: 0, data: { user_id: id } } };
    calls.push(body);
    return { status: 200, body: { errCode: 0, data: { page: body.page, page_size: 10, total: items.length, items: items.slice((body.page - 1) * 10, body.page * 10) } } };
  } };
}
async function collect(items, options = {}) {
  const server = remote(items, options.id);
  const snapshot = await collectSnapshot({ ...range, ...options, request: server.request, pause: async () => {}, now: options.now || (() => NOW) });
  return { snapshot, calls: server.calls };
}
const ordered = count => Array.from({ length: count }, (_, i) => row(i));

test('unchanged 403-row history uses two pages per pass and keeps the entire prior tail', async () => {
  const items = ordered(403);
  const { snapshot: previous, calls: full } = await collect(items);
  const { snapshot, calls } = await collect(items, { previous });
  assert.equal(full.length, 82); assert.equal(calls.length, 4);
  assert.equal(snapshot.reusedRecords, 383); assert.equal(snapshot.pagesRead, 2);
  assert.deepEqual(snapshot.items, items); assert.equal(snapshot.fingerprint, previous.fingerprint);
  assert.equal(snapshot.consistency, 'two-matching-prefixes-cached-tail');
  assert.equal(snapshot.fullReadAt, previous.updatedAt);
});

test('new rows and changed recent aggregates replace the prefix instead of accumulating it', async () => {
  const items = ordered(100); const { snapshot: previous } = await collect(items);
  const updated = [{ ...row(-2) }, { ...row(-1) }, ...items];
  updated[4] = { ...updated[4], total_input_tokens: 17, total_tokens: 20 };
  const { snapshot, calls } = await collect(updated, { previous });
  assert.equal(calls.length, 6); assert.deepEqual(snapshot.items, updated);
  assert.equal(snapshot.totals.total_tokens, 1030);
  const repeat = await collect(updated, { previous: snapshot });
  assert.equal(repeat.snapshot.totals.total_tokens, 1030); assert.equal(repeat.calls.length, 4);
});

test('same-second groups spanning page boundaries and identical rows retain all occurrences', async () => {
  const items = ordered(100);
  for (let i = 10; i < 35; i++) items[i] = { ...items[10] };
  const { snapshot: previous } = await collect(items);
  const { snapshot, calls } = await collect(items, { previous });
  assert.equal(calls.length, 8); assert.deepEqual(snapshot.items, items);
  const duplicate = { ...items[10] };
  const added = [...items.slice(0, 10), duplicate, ...items.slice(10)];
  const next = await collect(added, { previous: snapshot });
  assert.equal(next.snapshot.total, 101); assert.equal(fingerprint(next.snapshot.items), fingerprint(added));
});

test('count decrease, unordered baseline, account change and expired full check force all pages', async () => {
  const items = ordered(100); const { snapshot: previous } = await collect(items);
  for (const [rows, options, pages] of [
    [items.slice(0, -1), { previous }, 20],
    [items, { previous: { ...previous, items: [...items].reverse() } }, 20],
    [items, { previous, id: 'account-b' }, 20],
    [items, { previous, now: () => new Date(Date.parse(NOW) + 86400000).toISOString() }, 20],
    [items, { previous, forceFull: true }, 20]
  ]) assert.equal((await collect(rows, options)).calls.length, pages);
});

test('rolling range drops old out-of-range cached rows and extends forward without double counting', async () => {
  const items = [...ordered(80), ...ordered(20).map(r => ({ ...r, first_create_time: new Date('2026-10-10T00:00:00').getTime() / 1000 }))];
  const { snapshot: previous } = await collect(items);
  const current = [ { ...row(0), first_create_time: new Date('2026-10-17T00:00:00').getTime() / 1000 }, ...items.slice(0, 80) ];
  const result = await collect(current, { previous, startDate: '2026-10-11', endDate: '2026-10-17' });
  assert.equal(result.calls.length, 6); assert.deepEqual(result.snapshot.items, current);
});

test('incremental reuse never extends the full-check deadline; explicit full check corrects a changed old tail', async () => {
  const items = ordered(100); const { snapshot: original } = await collect(items);
  const quick = await collect(items, { previous: original, now: () => new Date(Date.parse(NOW) + 86400000 - 60000).toISOString() });
  assert.equal(quick.snapshot.fullReadAt, NOW);
  const changed = items.map((r, i) => i === 90 ? { ...r, total_tokens: 20, total_input_tokens: 17 } : r);
  const repaired = await collect(changed, { previous: quick.snapshot, now: () => new Date(Date.parse(NOW) + 86400000 + 60000).toISOString() });
  assert.equal(repaired.calls.length, 20); assert.equal(repaired.snapshot.totals.total_tokens, 1010);
  const forced = await collect(changed, { previous: original, forceFull: true });
  assert.equal(forced.snapshot.totals.total_tokens, 1010);
});

test('changed prefix between two reads falls back to a full retry', async () => {
  const items = ordered(100); const { snapshot: previous } = await collect(items);
  const changed = items.map((r,i) => i === 0 ? { ...r, total_tokens: 20, total_input_tokens: 17 } : r);
  const old = remote(items), next = remote(changed); let starts = 0;
  const snapshot = await collectSnapshot({ ...range, previous, now: () => NOW, pause: async () => {}, request: (url, body) => {
    if (body?.page === 1) starts++;
    return (starts < 2 ? old : next).request(url, body);
  } });
  assert.equal(snapshot.consistency, 'two-equal-reads'); assert.equal(snapshot.totals.total_tokens, 1010);
  assert.equal(old.calls.length + next.calls.length, 25);
});

test('Eco model separation reaches groups, periods, daily history and aliases without changing raw fields', async () => {
  const normal = row(0), eco = { ...row(1), business_sub_type: 'eco_mode', total_credits: 0 };
  const { snapshot } = await collect([normal, eco]);
  assert.deepEqual(groupItems(snapshot.items, 'model_name').map(r => r.name).sort(), ['vendor/model', 'vendor/model[eco]']);
  const usage = projectHistory([{ ...snapshot, profileId: 'p' }], 'p');
  const shown = statsForDisplay({ periods: { allTime: {} } }, usage, Date.parse(NOW));
  const aliases = { 'vendor/model': 'renamed', 'vendor/model[eco]': 'renamed' };
  const aliased = projectModelAliasStats(shown, aliases, { grouping: 'off' });
  assert.deepEqual(aliased.periods.allTime.models, { renamed: 10, 'renamed[eco]': 10 });
  assert.deepEqual(aliased.periods.allTime.modelCredits, { renamed: 0.5, 'renamed[eco]': 0 });
  const history = projectModelAliasHistory(historyForDisplay(null, usage, Date.parse(NOW)), aliases, { grouping: 'off' });
  assert.equal(history.daily.at(-1).perModel['renamed[eco]'].tokens, 10);
  assert.equal(history.daily.at(-1).perModel.renamed.tokens, 10);
  assert.equal(snapshot.items[1].model_name, 'vendor/model');
});

test('controller resumes persisted checkpoint after restart and reconciles a newer overlapping snapshot', async t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { randomUUID } = require('node:crypto');
  const { VerdentStore } = require('../../src/electron/providers/verdent/store');
  const { VerdentController } = require('../../src/electron/providers/verdent/controller');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdent-checkpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'usage.json'); const profileId = randomUUID();
  const items = ordered(100);
  const { snapshot: baseline } = await collect(items, { ...historyScope(Date.now()), now: () => new Date().toISOString() });
  const original = new VerdentStore(file);
  original.update({ enabled: false, activeProfile: profileId, profiles: [{ id: profileId, label: 'Test' }], intervalMinutes: 0, rangeMode: 'fixed', range: baseline.scope });
  original.replace(profileId, baseline);
  const store = new VerdentStore(file); // A fresh process reads the durable baseline.
  const server = remote(items);
  const controller = new VerdentController({ store, browserFactory: () => ({ request: server.request, persist: async () => {}, close() {} }) });
  t.after(() => controller.dispose());
  controller.configure({ enabled: true });
  assert.equal((await controller.refresh()).error, null); assert.equal(server.calls.length, 4);
  assert.equal(store.data.snapshots[0].fullReadAt, baseline.fullReadAt);
  const narrow = await collect(items, { startDate: '2026-10-16', endDate: '2026-10-16', now: () => new Date(Date.now() + 1000).toISOString() });
  store.replace(profileId, narrow.snapshot);
  server.calls.length = 0;
  assert.equal((await controller.refresh()).error, null); assert.equal(server.calls.length, 20);
  const persisted = new VerdentStore(file);
  assert.equal(persisted.data.snapshots.find(s => s.scope.kind === 'allHistory').items.length, 100);
});
