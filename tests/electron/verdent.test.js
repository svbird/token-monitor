'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { collectSnapshot, scopeForDates, summarize, parseItem, groupItems, fingerprint, compareSnapshots, IDENTITY_ENDPOINT, VerdentError } = require('../../src/electron/providers/verdent/usage');
const { VerdentStore } = require('../../src/electron/providers/verdent/store');
const { VerdentController, safeError } = require('../../src/electron/providers/verdent/controller');
const { safeNavigation } = require('../../src/electron/providers/verdent/browserSession');

// Entirely synthetic usage; never copy account history into public fixtures.
const fixture = [
  { feature: 'Enhancement', model_name: 'synthetic-model-a', platform: 'Verdent', source: 'verdent', business_sub_type: 'eco_mode', subagent_type: 'Manager Enhancement', first_create_time: new Date('2026-10-16T09:00:02').getTime() / 1000, total_cache_read_tokens: 250, total_cache_creation_tokens: 0, total_input_tokens: 7000, total_output_tokens: 500, total_tokens: 7750, total_credits: 0 },
  { feature: 'Main Agent', model_name: 'synthetic-model-a', platform: 'Verdent', source: 'verdent', business_sub_type: 'eco_mode', subagent_type: '', first_create_time: new Date('2026-10-16T09:00:01').getTime() / 1000, total_cache_read_tokens: 300000, total_cache_creation_tokens: 0, total_input_tokens: 4500, total_output_tokens: 1000, total_tokens: 305500, total_credits: 0 }
];
const range = { startDate: '2026-10-10', endDate: '2026-10-16' };
const identity = user_id => ({ status: 200, body: { errCode: 0, data: { user_id } } });
const pageReply = (items, page, total = items.length) => ({ status: 200, body: { errCode: 0, errMsg: '', data: { items, total, page, page_size: 10 } } });
const options = request => ({ ...range, request, pause: async () => {} });
function source(items = fixture) {
  return async (url, body) => url === IDENTITY_ENDPOINT ? identity('account-a') : pageReply(items.slice((body.page - 1) * 10, body.page * 10), body.page, items.length);
}
function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdent-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new VerdentStore(path.join(dir, 'usage.json'));
}

test('system-local date boundaries use second timestamps, following the host timezone', () => {
  const scope = scopeForDates(range.startDate, range.endDate);
  assert.equal(scope.start_time, new Date('2026-10-10T00:00:00').getTime() / 1000); assert.equal(scope.end_time, new Date('2026-10-17T00:00:00').getTime() / 1000 - 1);
  for (const date of ['2026-02-30', '2026-13-01', '2026-1-01', '', null]) assert.throws(() => scopeForDates(date, range.endDate));
  assert.throws(() => scopeForDates('2026-10-17', '2026-10-16'));
  assert.throws(() => scopeForDates('2020-01-01', '2026-10-16'));
});

test('synthetic two-item fixture preserves independent cache buckets and zero credits', async () => {
  const snapshot = await collectSnapshot(options(source()));
  assert.deepEqual(snapshot.totals, { total_input_tokens: 11500, total_output_tokens: 1500, total_cache_read_tokens: 300250, total_cache_creation_tokens: 0, total_tokens: 313250, total_credits: 0 });
  assert.equal(snapshot.total, 2); assert.deepEqual(snapshot.items, fixture);
  assert.equal(groupItems(snapshot.items, 'feature').find(g => g.name === 'Main Agent').total_tokens, 305500);
  assert.equal(groupItems(snapshot.items, 'subagent_type').find(g => g.name === '').items, 1);
});

test('403 synthetic records require 41 sequential pages per pass, preserving identical rows', async () => {
  const items = Array.from({ length: 403 }, () => ({ ...fixture[0] }));
  let active = 0; let maxActive = 0; const bodies = []; const waits = [];
  const request = async (url, body) => {
    active++; maxActive = Math.max(maxActive, active);
    try { await Promise.resolve(); if (body) bodies.push(body); return await source(items)(url, body); }
    finally { active--; }
  };
  const snapshot = await collectSnapshot({ ...options(request), pause: async ms => { waits.push(ms); } });
  assert.equal(bodies.length, 82); assert.equal(snapshot.total, 403); assert.equal(snapshot.pages, 41);
  assert.equal(snapshot.totals.total_tokens, 403 * 7750); assert.equal(maxActive, 1);
  assert.equal(waits.filter(ms => ms === 350).length, 80);
  assert.ok(bodies.every(b => b.start_time === new Date('2026-10-10T00:00:00').getTime() / 1000 && b.end_time === new Date('2026-10-17T00:00:00').getTime() / 1000 - 1 && b.team_id === '0' && b.consume_type === '' && b.page_size === 10));
});

test('same-second and completely identical records are never deduplicated', async () => {
  const items = [fixture[0], fixture[0], { ...fixture[1], first_create_time: fixture[0].first_create_time }];
  const snapshot = await collectSnapshot(options(source(items)));
  assert.equal(snapshot.total, 3); assert.equal(snapshot.totals.total_tokens, 7750 * 2 + 305500);
  assert.notEqual(fingerprint(items), fingerprint(items.slice(1)));
  assert.equal(fingerprint(items), fingerprint([...items].reverse()));
});

test('first-create date and second grouping use system-local boundaries without dropping same-second records', () => {
  const midnight = scopeForDates('2026-10-16', '2026-10-16').start_time;
  const rows = [{ ...fixture[0], first_create_time: midnight - 1 }, { ...fixture[0], first_create_time: midnight }, { ...fixture[1], first_create_time: midnight }];
  const daily = groupItems(rows, 'first_create_date');
  assert.equal(daily[0].name, '2026-10-16'); assert.equal(daily[0].items, 2); assert.equal(daily[0].total_tokens, 313250);
  assert.equal(daily[1].name, '2026-10-15'); assert.equal(daily[1].total_tokens, 7750);
  const perSecond = groupItems(rows, 'first_create_time');
  assert.equal(perSecond[0].name, String(midnight)); assert.equal(perSecond[0].items, 2);
  assert.equal(perSecond[0].total_tokens, 313250);
});

test('refresh comparison preserves multiplicity and never calls changed rows requests', async () => {
  const before = await collectSnapshot(options(source([fixture[0], fixture[0]])));
  const after = await collectSnapshot(options(source([fixture[0], fixture[1]])));
  const changed = compareSnapshots(before, after);
  assert.equal(changed.unchanged, false); assert.equal(changed.addedOccurrences, 1); assert.equal(changed.removedOccurrences, 1);
  assert.equal(changed.deltas.total_tokens, 305500 - 7750);
  assert.equal(compareSnapshots(before, before).unchanged, true);
  assert.equal(compareSnapshots(null, after), null);
});

test('unknown dimensions and empty subagent are valid; untrusted extra fields do not enter usage storage', () => {
  const row = parseItem({ ...fixture[0], model_name: '__proto__', feature: '<img onerror=alert(1)>', subagent_type: '', auth_token: 'secret' }, 0);
  assert.equal(row.auth_token, undefined); assert.equal(groupItems([row], 'model_name')[0].name, '__proto__[eco]');
  assert.equal(groupItems([row], 'feature')[0].name, '<img onerror=alert(1)>');
});

test('HTTP, API, invalid pages, malformed numbers and identity failures reject complete snapshots', async t => {
  const replies = [
    { status: 401 }, { status: 403 }, { status: 429 }, { status: 200, body: { errCode: 42, errMsg: 'secret' } },
    pageReply([], 2, 1), pageReply([], 1, 1), { status: 200, body: { errCode: 0, data: { total: '2', page: 1, page_size: 10, items: fixture } } },
    pageReply([{ ...fixture[0], total_input_tokens: NaN }], 1), pageReply([{ ...fixture[0], total_credits: -1 }], 1),
    pageReply([{ ...fixture[0], total_output_tokens: '500' }], 1), pageReply([{ ...fixture[0], source: undefined }], 1)
  ];
  for (const [i, reply] of replies.entries()) await t.test(String(i), async () => {
    await assert.rejects(collectSnapshot(options(async url => url === IDENTITY_ENDPOINT ? identity('a') : reply)), error => !error.message.includes('secret'));
  });
  await assert.rejects(collectSnapshot(options(async () => identity(undefined))), { code: 'identity' });
});

test('component mismatches retain original fields and prevent successful replacement', async () => {
  const bad = { ...fixture[0], total_tokens: 1 };
  await assert.rejects(collectSnapshot(options(source([bad]))), error => {
    assert.equal(error.code, 'components'); assert.deepEqual(error.anomalies, [bad]); return true;
  });
});

test('changed total triggers bounded retry; perpetual drift fails', async () => {
  let calls = 0;
  await assert.rejects(collectSnapshot(options(async (url, body) => {
    if (url === IDENTITY_ENDPOINT) return identity('a');
    calls++;
    return pageReply(Array(10).fill(fixture[0]), body.page, body.page === 1 ? 11 : 12);
  })), { code: 'drift' });
  assert.equal(calls, 4);
});

test('equal totals with changed content are detected; later stable pair succeeds', async () => {
  let calls = 0;
  const request = async (url, body) => {
    if (url === IDENTITY_ENDPOINT) return identity('a');
    calls++;
    return pageReply(calls === 1 ? [fixture[0]] : [fixture[1]], body.page);
  };
  const snapshot = await collectSnapshot(options(request));
  assert.equal(calls, 4); assert.equal(snapshot.totals.total_tokens, 305500);
});

test('account change during collection discards candidate', async () => {
  let ids = 0;
  await assert.rejects(collectSnapshot(options(async (url, body) => url === IDENTITY_ENDPOINT ? identity(++ids === 1 ? 'a' : 'b') : pageReply(fixture, body.page))), { code: 'accountChanged' });
});

test('empty range is complete and can replace a nonempty snapshot', async () => {
  const snapshot = await collectSnapshot(options(source([])));
  assert.equal(snapshot.total, 0); assert.equal(snapshot.pages, 1); assert.equal(snapshot.totals.total_tokens, 0);
});

test('atomic snapshots replace same range, keep overlapping ranges separate, and survive restart', async t => {
  const store = tempStore(t); const profileId = crypto.randomUUID();
  store.update({ profiles: [{ id: profileId, label: 'Local' }], activeProfile: profileId });
  const snapshot = await collectSnapshot(options(source()));
  store.replace(profileId, snapshot); store.replace(profileId, snapshot);
  assert.equal(store.data.snapshots.length, 1);
  store.replace(profileId, { ...snapshot, scope: scopeForDates('2026-10-11', '2026-10-16') });
  store.replace(profileId, { ...snapshot, accountKey: 'a'.repeat(64) });
  assert.equal(store.data.snapshots.length, 3);
  const restarted = new VerdentStore(store.file);
  assert.equal(restarted.data.snapshots.length, 3);
  const before = store.data; store.write = () => { throw new Error('disk full'); };
  assert.throws(() => store.replace(profileId, snapshot)); assert.strictEqual(store.data, before);
  assert.equal(new VerdentStore(store.file).data.snapshots.length, 3);
});

test('corrupt store fails closed without replacing the file', t => {
  const store = tempStore(t); fs.writeFileSync(store.file, '{broken');
  assert.throws(() => new VerdentStore(store.file)); assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
});

test('controller retains last successful data on expiry, anomalies and write failure; profiles isolate cache', async t => {
  const store = tempStore(t); let request = source();
  const browser = { request: (...args) => request(...args), close() {} };
  const controller = new VerdentController({ store, browserFactory: () => browser }); t.after(() => controller.dispose());
  controller.addProfile('One'); const one = store.data.activeProfile;
  controller.configure({ enabled: true, ...range });
  // Keep real controller flow, without the default page pause in these tiny fixtures.
  controller.options = signal => ({ ...options((...args) => browser.request(...args)), signal });
  await controller.refresh(); assert.equal(controller.state().selected.totals.total_tokens, 313250);
  request = async () => ({ status: 401 }); await controller.refresh();
  assert.equal(controller.state().error.code, 'auth'); assert.equal(controller.state().selected.totals.total_tokens, 313250);
  request = source([{ ...fixture[0], total_tokens: 9 }]); await controller.refresh();
  assert.equal(controller.state().anomalies[0].total_tokens, 9); assert.equal(controller.state().selected.totals.total_tokens, 313250);
  request = source([]); store.write = () => { throw new Error('private path'); }; await controller.refresh();
  assert.equal(controller.state().error.code, 'storage'); assert.equal(controller.state().selected.totals.total_tokens, 313250);
  store.write = require('../../src/shared/credentialStore').writePrivateJsonAtomic;
  controller.addProfile('Two'); assert.equal(controller.state().selected, null); assert.equal(controller.state().history.length, 0);
  controller.configure({ activeProfile: one }); assert.equal(controller.state().history.length, 1);
});

test('cancelled collection and disabling prevent network or publication', async t => {
  const store = tempStore(t); const controller = new VerdentController({ store, browserFactory: () => { throw new Error('must not call'); } });
  t.after(() => controller.dispose()); await assert.rejects(controller.refresh(), { code: 'disabled' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(collectSnapshot({ ...options(source()), signal: abort.signal }));
  assert.equal(store.data.snapshots.length, 0);
});

test('seven-day diagnostic compares every bucket without committing daily usage', async t => {
  const store = tempStore(t);
  const scope = scopeForDates(range.startDate, range.endDate);
  const rows = Array.from({ length: 7 }, (_, i) => ({ ...fixture[0], first_create_time: scope.start_time + i * 86400 + 30 }));
  const browser = { close() {}, async request(url, body) {
    if (url === IDENTITY_ENDPOINT) return identity('account-a');
    return pageReply(rows.filter(r => r.first_create_time >= body.start_time && r.first_create_time <= body.end_time), body.page);
  } };
  const controller = new VerdentController({ store, browserFactory: () => browser }); t.after(() => controller.dispose());
  controller.addProfile('One'); controller.configure({ enabled: true, ...range });
  controller.options = signal => ({ ...options((...args) => browser.request(...args)), signal });
  controller.selectHistory(range);
  await controller.validateWeek();
  assert.equal(controller.state().error, null); const result = controller.state().validation;
  assert.equal(result.stable, true); assert.equal(result.sumsMatch, true); assert.equal(result.daily.length, 7);
  assert.equal(result.weekly.total_tokens, 7 * 7750); assert.equal(store.data.snapshots.length, 0);
  assert.match(result.sessionTransport, /成功/);
});

test('refresh timers are configurable and disabled modules close browser pages', t => {
  const store = tempStore(t); let closes = 0;
  const controller = new VerdentController({ store, browserFactory: () => ({ close() { closes++; } }) }); t.after(() => controller.dispose());
  controller.addProfile('One'); controller.browser();
  controller.configure({ enabled: true, intervalMinutes: 5, ...range }); assert.ok(controller.timer);
  controller.configure({ intervalMinutes: 0 }); assert.equal(controller.timer, null);
  controller.configure({ intervalMinutes: 15 }); assert.ok(controller.timer);
  controller.configure({ enabled: false }); assert.equal(controller.timer, null); assert.equal(closes, 1);
  assert.throws(() => controller.configure({ intervalMinutes: 0.001 }));
});

test('refresh defaults to 30 seconds and persists whole-second intervals down to one second', t => {
  const store = tempStore(t);
  assert.equal(store.data.intervalMinutes * 60, 30);
  const controller = new VerdentController({ store }); t.after(() => controller.dispose());
  for (const seconds of [0, 1, 7, 30, 59, 60, 300, 3600]) {
    controller.configure({ intervalMinutes: seconds / 60 });
    assert.equal(Math.round(new VerdentStore(store.file).data.intervalMinutes * 60), seconds);
  }
  for (const value of [-1, 0.5 / 60, 1.5 / 60, 3601 / 60, NaN, Infinity, '0.5', null]) {
    assert.throws(() => controller.configure({ intervalMinutes: value }), { code: 'settings' });
  }
});

test('one-second polling waits for completion and never queues overlapping refreshes', async t => {
  const store = tempStore(t); let now = new Date('2027-04-15T12:00:00').getTime();
  const controller = new VerdentController({ store, now: () => now }); t.after(() => controller.dispose());
  controller.addProfile('Synthetic'); controller.lastAttemptAt = now;
  controller.configure({ enabled: true, intervalMinutes: 1 / 60 });
  await controller.run(async () => {});
  assert.equal(controller.nextRefreshAt, now + 1000);
  let finish;
  const operation = controller.run(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(controller.nextRefreshAt, null);
  now += 45000;
  assert.equal((await controller.refresh()).busy, true);
  controller.wake(); assert.equal(controller.timer, null);
  finish(); await operation;
  assert.equal(controller.nextRefreshAt, now + 1000);
  controller.configure({ intervalMinutes: 0 }); assert.equal(controller.timer, null);
});

test('safe errors omit arbitrary network bodies and navigation rejects unsafe schemes', () => {
  assert.ok(!JSON.stringify(safeError(new Error('Cookie=password; token=secret'))).includes('secret'));
  assert.equal(safeError(new VerdentError('auth', '重新登录')).code, 'auth');
  for (const url of ['file:///C:/secrets', 'javascript:alert(1)', 'http://verdent.ai', 'https://user:password@verdent.ai']) assert.equal(safeNavigation(url), false);
  assert.equal(safeNavigation('https://login.verdent.ai'), true);
  assert.equal(summarize(fixture).total_credits, 0);
});

module.exports = { fixture };

test('collection always covers all history through the current clock; viewing history never limits it', t => {
  const store = tempStore(t); let now = new Date('2026-10-31T23:59:59').getTime();
  const controller = new VerdentController({ store, now: () => now });
  t.after(() => controller.dispose());
  for (const rangeMode of ['fixed', 'today', 'last7', 'month', 'allHistory']) {
    controller.configure({ rangeMode, ...range });
    assert.equal(controller.state().rangeMode, 'allHistory');
    assert.equal(controller.collectionRange().startDate, '2026-07-31');
    assert.equal(controller.collectionRange().end_time, Math.floor(now / 1000));
  }
  const before = controller.collectionRange().end_time; now += 1000;
  assert.equal(controller.collectionRange().endDate, '2026-11-01');
  assert.equal(controller.collectionRange().end_time, before + 1);
  controller.selectHistory(range);
  assert.equal(controller.collectionRange().startDate, '2026-08-01');
  assert.equal(controller.collectionRange().end_time, Math.floor(now / 1000));
});

test('legacy store migrates collection to all history, preserving snapshots, account and manual refresh preference', t => {
  const store = tempStore(t); const id = crypto.randomUUID();
  const legacy = { ...store.data, intervalMinutes: 0, range: scopeForDates(range.startDate, range.endDate), profiles: [{ id, label: 'Existing' }], activeProfile: id };
  delete legacy.rangeMode; fs.writeFileSync(store.file, JSON.stringify(legacy));
  const migrated = new VerdentStore(store.file);
  assert.equal(migrated.data.rangeMode, 'allHistory'); assert.equal(migrated.data.intervalMinutes, 0);
  assert.equal(migrated.data.activeProfile, id); assert.deepEqual(migrated.data.range, legacy.range);
});

test('manual app startup collects immediately; resume catches up due work and auth failure pauses automation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = tempStore(t); const id = crypto.randomUUID(); let now = Date.parse('2027-01-01T00:00:00Z');
  store.update({ enabled: true, intervalMinutes: 15, rangeMode: 'fixed', range: scopeForDates(range.startDate, range.endDate), profiles: [{ id, label: 'Existing' }], activeProfile: id });
  const snapshot = await collectSnapshot(options(source()));
  store.replace(id, { ...snapshot, updatedAt: new Date(now - 60000).toISOString() });
  let request = source(); let requests = 0;
  const controller = new VerdentController({ store, now: () => now, browserFactory: () => ({ request: (...args) => { requests++; return request(...args); }, close() {} }) });
  t.after(() => controller.dispose());
  const original = controller.options.bind(controller);
  controller.options = signal => ({ ...original(signal), pause: async () => {} });
  assert.equal(controller.nextRefreshAt, now); assert.equal(requests, 0);
  t.mock.timers.tick(1);
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests > 0); assert.equal(controller.nextRefreshAt, now + 15 * 60000);
  now += 16 * 60000; controller.wake(); assert.equal(controller.nextRefreshAt, now);
  t.mock.timers.tick(1);
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests > 0); assert.equal(controller.state().error, null); assert.equal(store.data.snapshots.length, 2);
  assert.equal(controller.nextRefreshAt, now + 15 * 60000);
  request = async () => ({ status: 401 }); await controller.refresh();
  assert.equal(controller.nextRefreshAt, null); assert.equal(controller.timer, null);
  assert.equal(controller.state().selected.totals.total_tokens, 313250);
  controller.wake(); assert.equal(controller.timer, null);
  request = source(); await controller.refresh(); assert.ok(controller.nextRefreshAt);
  controller.configure({ enabled: false }); const count = requests; controller.refreshFromApp(); controller.wake();
  assert.equal(requests, count); assert.equal(controller.timer, null);
});

test('manual-only mode collects once on app startup and does not install a recurring timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = tempStore(t); const id = crypto.randomUUID();
  store.update({ enabled: true, intervalMinutes: 0, rangeMode: 'fixed', range: scopeForDates(range.startDate, range.endDate), profiles: [{ id, label: 'Existing' }], activeProfile: id });
  const controller = new VerdentController({ store, browserFactory: () => ({ request: source(), close() {} }) });
  t.after(() => controller.dispose());
  const original = controller.options.bind(controller); controller.options = signal => ({ ...original(signal), pause: async () => {} });
  assert.ok(controller.timer); t.mock.timers.tick(1);
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.state().selected.totals.total_tokens, 313250);
  assert.equal(controller.timer, null); controller.wake(); assert.equal(controller.timer, null);
});

test('settings IPC accepts only trusted local top-level views and broadcasts shared configuration', async t => {
  const { installVerdent } = require('../../src/electron/providers/verdent/controller');
  const { pathToFileURL } = require('node:url');
  const { EventEmitter } = require('node:events');
  const store = tempStore(t); const handlers = new Map(); const powerMonitor = new EventEmitter();
  const extension = installVerdent({ app: { getPath: () => path.dirname(store.file) }, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, powerMonitor });
  t.after(() => extension.dispose());
  const messages = []; const frame = {};
  const sender = { mainFrame: frame, getURL: () => pathToFileURL(path.resolve(__dirname, '../../src/electron/renderer/index.html')).href, isDestroyed: () => false, send: (channel, state) => messages.push({ channel, state }) };
  const command = handlers.get('verdent:command');
  assert.equal((await command({ sender, senderFrame: {} }, 'get')).error.code, 'ipc');
  const remote = { ...sender, getURL: () => 'https://www.verdent.ai/dashboard' };
  assert.equal((await command({ sender: remote, senderFrame: frame }, 'get')).error.code, 'ipc');
  const result = await command({ sender, senderFrame: frame }, 'configure', { intervalMinutes: 30, rangeMode: 'today' });
  assert.equal(result.intervalMinutes, 30); assert.equal(messages.at(-1).state.rangeMode, 'allHistory');
  assert.equal(powerMonitor.listenerCount('resume'), 1); extension.dispose();
  assert.equal(powerMonitor.listenerCount('resume'), 0);
});
