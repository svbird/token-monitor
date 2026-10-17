'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { historyScope, scopeForDates, scopeKey, collectSnapshot, IDENTITY_ENDPOINT } = require('../../src/electron/providers/verdent/usage');
const { VerdentStore } = require('../../src/electron/providers/verdent/store');
const { projectHistory } = require('../../src/electron/providers/verdent/history');
const { projectPeriod } = require('../../src/electron/providers/verdent/presentation');

const now = new Date('2027-04-15T12:00:00').getTime();
const record = seconds => ({ first_create_time: seconds, model_name: 'synthetic-history', feature: 'Main Agent', subagent_type: '', business_sub_type: '', source: 'verdent', platform: 'Verdent', total_input_tokens: 7, total_output_tokens: 1, total_cache_read_tokens: 2, total_cache_creation_tokens: 0, total_tokens: 10, total_credits: 0 });
const recent = Array.from({ length: 90 }, (_, i) => record(now / 1000 - 60 - i));
const items = [...recent, ...Array.from({ length: 10 }, (_, i) => record(new Date('2027-02-01T12:00:00').getTime() / 1000 - i))];
async function collect(rows, options = {}) {
  const at = options.at || now;
  const calls = [];
  const snapshot = await collectSnapshot({ ...historyScope(at), now: () => new Date(at).toISOString(), pause: async () => {}, ...options,
    request: async (url, body) => {
      if (url === IDENTITY_ENDPOINT) return { status: 200, body: { errCode: 0, data: { user_id: 'synthetic-account' } } };
      calls.push(body);
      return { status: 200, body: { errCode: 0, data: { page: body.page, page_size: 10, total: rows.length, items: rows.slice((body.page - 1) * 10, body.page * 10) } } };
    } });
  return { snapshot, calls };
}

test('first all-history read fills data older than the existing range; subsequent days reuse the full tail', async () => {
  const previous = (await collect(recent)).snapshot;
  previous.scope = scopeForDates('2027-04-09', '2027-04-15');
  const full = await collect(items, { previous });
  assert.equal(full.calls.length, 20);
  assert.ok(full.calls.every(body => body.start_time === new Date('2027-01-15T00:00:00').getTime() / 1000 && body.end_time === now / 1000 && body.page_size === 10));
  assert.equal(full.snapshot.total, 100);
  const later = await collect(items, { previous: full.snapshot, at: now + 3 * 86400000 });
  assert.equal(later.calls.length, 4);
  assert.equal(later.snapshot.fullReadAt, full.snapshot.fullReadAt);
  assert.deepEqual(later.snapshot.items, items);
  assert.equal(scopeKey(later.snapshot.scope), scopeKey(full.snapshot.scope));
  const newRows = [record((now + 3 * 86400000) / 1000 - 1), ...items];
  const appended = await collect(newRows, { previous: later.snapshot, at: now + 3 * 86400000 });
  assert.equal(appended.snapshot.total, 101);
  assert.ok(appended.calls.length < 22);
});

test('all-history refresh atomically replaces one account snapshot and display filters never limit it', async () => {
  const old = (await collect(items)).snapshot;
  const refreshed = (await collect(items, { previous: old, at: now + 86400000 })).snapshot;
  let persisted;
  const store = new VerdentStore('unused', { read: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, write: (_file, value) => { persisted = JSON.stringify(value); } });
  const profileId = '11111111-1111-1111-1111-111111111111';
  store.update({ profiles: [{ id: profileId, label: 'Synthetic' }], activeProfile: profileId });
  store.replace(profileId, old); store.replace(profileId, refreshed);
  assert.equal(store.data.snapshots.length, 1);
  const reloaded = new VerdentStore('unused', { read: () => persisted, write: () => {} });
  assert.equal(reloaded.data.snapshots[0].total, 100);
  const usage = projectHistory(reloaded.data.snapshots, profileId);
  assert.equal(usage.coverage.start, '2027-02-01');
  assert.equal(projectPeriod({}, usage, 'today', now).totalTokens, 900);
  assert.equal(projectPeriod({}, usage, 'month', now).totalTokens, 900);
  assert.equal(projectPeriod({}, usage, 'allTime', now).totalTokens, 1000);
  assert.equal(reloaded.data.snapshots[0].total, 100);
  assert.deepEqual(reloaded.data.snapshots[0].items, items);
});

test('explicit full reread corrects old-tail changes and failed reads preserve the last snapshot', async () => {
  const old = (await collect(items)).snapshot;
  const changed = items.map((row, i) => i === 95 ? { ...row, total_input_tokens: 17, total_tokens: 20 } : row);
  const full = await collect(changed, { previous: old, forceFull: true });
  assert.equal(full.calls.length, 20); assert.equal(full.snapshot.totals.total_tokens, 1010);
  await assert.rejects(collectSnapshot({ ...historyScope(now), previous: old, request: async () => ({ status: 401 }) }), { code: 'auth' });
  assert.equal(old.totals.total_tokens, 1000);
});

test('online cutoff uses three local calendar months, clamps month ends, and freezes the current second', () => {
  for (const [date, startDate] of [['2027-05-31', '2027-02-28'], ['2028-05-31', '2028-02-29'], ['2027-01-30', '2026-10-30']]) {
    const at = new Date(`${date}T15:23:45.678`).getTime();
    const scope = historyScope(at);
    assert.equal(scope.startDate, startDate);
    assert.equal(scope.start_time, new Date(`${startDate}T00:00:00`).getTime() / 1000);
    assert.equal(scope.end_time, Math.floor(at / 1000));
  }
});

test('retention rollover archives expired rows atomically, keeps duplicates and survives restart without double counting', async () => {
  const profileId = '11111111-1111-1111-1111-111111111111';
  const archivedRow = record(new Date('2027-01-15T00:00:00').getTime() / 1000);
  const original = [...items, archivedRow, archivedRow];
  const old = (await collect(original)).snapshot;
  const next = (await collect(items, { previous: old, at: now + 86400000 })).snapshot;
  assert.ok(next.reusedRecords > 0);
  let saved; let fail = false;
  const store = new VerdentStore('unused', { read: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); },
    write: (_file, value) => { if (fail) throw new Error('synthetic disk failure'); saved = JSON.stringify(value); } });
  store.update({ profiles: [{ id: profileId, label: 'Synthetic' }], activeProfile: profileId });
  store.replace(profileId, old);
  fail = true;
  assert.throws(() => store.replace(profileId, next), { code: 'storage' });
  assert.equal(store.data.snapshots.length, 1);
  assert.equal(store.data.snapshots[0].total, 102);
  fail = false;
  store.replace(profileId, next); store.replace(profileId, next);
  const reloaded = new VerdentStore('unused', { read: () => saved, write: () => {} });
  assert.equal(reloaded.data.snapshots.length, 2);
  const archive = reloaded.data.snapshots.find(s => s.scope.kind === 'archive');
  assert.deepEqual(archive.items, [archivedRow, archivedRow]);
  assert.equal(archive.updatedAt, old.updatedAt);
  assert.equal(projectPeriod({}, projectHistory(reloaded.data.snapshots, profileId), 'allTime', now + 86400000).totalTokens, 1020);
  // A new account in the same slot never inherits the old account's archive.
  store.replace(profileId, { ...next, accountKey: 'a'.repeat(64) });
  assert.equal(projectPeriod({}, projectHistory(store.data.snapshots, profileId, 'a'.repeat(64)), 'allTime', now + 86400000).totalTokens, 1000);
});

test('clock rollback preserves local records beyond the new query end; later refresh reconciles overlapping archives', async () => {
  const profileId = '11111111-1111-1111-1111-111111111111';
  const old = (await collect(items)).snapshot;
  const at = now - 86400000;
  const before = (await collect(items.slice(90), { previous: old, at })).snapshot;
  const store = new VerdentStore('unused', { read: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, write: () => {} });
  store.replace(profileId, old); store.replace(profileId, before);
  assert.equal(store.data.snapshots.find(s => s.scope.kind === 'archive').total, 90);
  assert.equal(projectPeriod({}, projectHistory(store.data.snapshots, profileId), 'allTime', now).totalTokens, 1000);
  const corrected = (await collect(items.slice(0, 99), { forceFull: true, at: now + 86400000 })).snapshot;
  store.replace(profileId, corrected);
  assert.equal(projectPeriod({}, projectHistory(store.data.snapshots, profileId), 'allTime', now + 86400000).totalTokens, 990);
});
