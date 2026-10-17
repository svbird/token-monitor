'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createBrowserSession, DASHBOARD, AUTH_SUCCESS_SCRIPT, isOAuthResponseUrl } = require('../../src/electron/providers/verdent/browserSession');
const { IDENTITY_ENDPOINT } = require('../../src/electron/providers/verdent/usage');
const { safeError } = require('../../src/electron/providers/verdent/controller');

function harness({ failInitial, cookieFailure, constructorFailure } = {}) {
  const windows = []; const statuses = []; const requests = [];
  const partition = new EventEmitter();
  Object.assign(partition, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, flushStorageData() {},
    clearStorageData: async () => {}, clearCache: async () => {}, cookies: { flushStore: async () => { if (cookieFailure) throw new Error('private cookie location'); } } });
  class Contents extends EventEmitter {
    constructor() { super(); this.url = ''; this.destroyed = false; this.body = ''; this.loading = false; }
    getURL() { return this.url; }
    isDestroyed() { return this.destroyed; }
    isLoadingMainFrame() { return this.loading; }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    async executeJavaScript(script) {
      const response = { status: 200, json: async () => ({ errCode: 0, data: { user_id: 'fixture-user' } }) };
      return vm.runInNewContext(script, { document: { contentType: 'application/json', querySelector: () => ({ textContent: this.body }) },
        fetch: async (url, options) => { requests.push({ url, options }); return response; }, AbortController, setTimeout, clearTimeout });
    }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); if (constructorFailure) throw new Error('private native error'); this.options = options; this.webContents = new Contents(); this.loads = []; windows.push(this); }
    static fromWebContents(contents) { return windows.find(w => w.webContents === contents); }
    async loadURL(url) {
      this.loads.push(url); this.webContents.url = url; this.webContents.body = ''; this.webContents.loading = true;
      await nextTurn(); this.webContents.loading = false;
      if (failInitial && this.loads.length === 1) { this.webContents.url = 'https://accounts.google.com/signin'; throw Object.assign(new Error('private callback?code=secret'), { code: failInitial }); }
      this.webContents.emit('did-finish-load');
    }
    show() { this.shown = true; } focus() {} isDestroyed() { return this.webContents.destroyed; }
    destroy() { this.webContents.destroyed = true; this.emit('closed'); } close() { this.destroy(); }
  }
  let partitionName;
  const browser = createBrowserSession({ BrowserWindow: Window, session: { fromPartition(name) { partitionName = name; return partition; } }, profileId: 'fixture-profile', onStatus: status => statuses.push(status) });
  return { browser, Window, windows, statuses, requests, partition, get partitionName() { return partitionName; } };
}

async function settle() { for (let i = 0; i < 5; i++) await nextTurn(); }

test('Google null-data JSON callback returns to Dashboard in the same persistent partition', async t => {
  const h = harness(); t.after(() => h.browser.close());
  await h.browser.login(); await settle();
  const win = h.windows[0];
  win.webContents.url = 'https://login.verdent.ai/passport/oauth/google/callback?code=DO_NOT_EXPOSE&state=DO_NOT_EXPOSE';
  win.webContents.body = '{"errCode":0,"errMsg":"","data":null}';
  win.webContents.emit('did-finish-load'); await settle();
  assert.equal(win.webContents.url, DASHBOARD); assert.equal(win.loads.length, 2);
  assert.equal(h.partitionName, 'persist:verdent-fixture-profile');
  assert.equal(win.options.webPreferences.session, h.partition);
  assert.equal(win.options.webPreferences.nodeIntegration, false); assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(h.statuses.at(-1).phase, 'dashboard'); assert.ok(!JSON.stringify(h.statuses).includes('DO_NOT_EXPOSE'));
  const reply = await h.browser.request(IDENTITY_ENDPOINT, null);
  assert.equal(reply.status, 200); assert.equal(h.requests[0].options.credentials, 'include');
  assert.equal(h.requests[0].options.headers.Authorization, undefined);
});

test('OAuth popup callback recovers the owner Dashboard and closes only the finished popup', async t => {
  const h = harness(); t.after(() => h.browser.close()); await h.browser.login(); await settle();
  const owner = h.windows[0]; const popup = new h.Window({});
  owner.webContents.emit('did-create-window', popup);
  popup.webContents.url = 'https://login.verdent.ai/passport/oauth/google/callback';
  popup.webContents.body = '{"errCode":0,"errMsg":"","data":null}';
  popup.webContents.emit('did-finish-load'); await settle();
  assert.equal(owner.webContents.url, DASHBOARD); assert.equal(owner.isDestroyed(), false); assert.equal(popup.isDestroyed(), true);
});

test('an aborted initial page load does not poison later authenticated requests', async t => {
  const h = harness({ failInitial: 'ERR_ABORTED' }); t.after(() => h.browser.close());
  await h.browser.login(); await settle();
  await assert.rejects(h.browser.request(IDENTITY_ENDPOINT, null), { code: 'auth' });
  h.windows[0].webContents.url = DASHBOARD;
  assert.equal((await h.browser.request(IDENTITY_ENDPOINT, null)).status, 200);
  assert.ok(!JSON.stringify(h.statuses).includes('secret'));
});

test('network failures can be retried by reopening login and are not reported as disk permissions', async t => {
  const h = harness({ failInitial: 'ERR_NAME_NOT_RESOLVED' }); t.after(() => h.browser.close());
  await h.browser.login(); await settle();
  await assert.rejects(h.browser.request(IDENTITY_ENDPOINT, null), { code: 'network' });
  await h.browser.login(); await settle();
  assert.equal((await h.browser.request(IDENTITY_ENDPOINT, null)).status, 200);
  assert.ok(!JSON.stringify(h.statuses).includes('private callback'));
});

test('ordinary Google login is pending, not a local error or proof of successful authentication', async t => {
  const h = harness(); t.after(() => h.browser.close()); await h.browser.login(); await settle();
  h.windows[0].webContents.url = 'https://accounts.google.com/signin';
  await h.browser.login();
  assert.equal(h.statuses.at(-1).phase, 'waiting');
  await assert.rejects(h.browser.request(IDENTITY_ENDPOINT, null), { code: 'auth' });
  assert.equal(h.requests.length, 0);
});

test('only trusted passport OAuth routes with null-data success trigger recovery', async t => {
  for (const url of ['https://evil.example/passport/oauth/google/callback', 'http://login.verdent.ai/passport/oauth/google/callback', 'https://login.verdent.ai/passport/logout']) assert.equal(isOAuthResponseUrl(url), false);
  const h = harness(); t.after(() => h.browser.close()); await h.browser.login(); await settle();
  const contents = h.windows[0].webContents;
  contents.url = 'https://login.verdent.ai/passport/oauth/google/callback';
  for (const body of ['{"errCode":1,"data":null}', '{"errCode":0,"data":{"token":"DO_NOT_EXPOSE"}}', '<html>login</html>']) {
    contents.body = body; contents.emit('did-finish-load'); await settle();
    assert.equal(h.windows[0].loads.length, 1);
  }
  assert.equal(typeof await contents.executeJavaScript(AUTH_SUCCESS_SCRIPT), 'boolean');
});

test('window construction and session persistence errors have separate safe categories', async t => {
  const badWindow = harness({ constructorFailure: true }); t.after(() => badWindow.browser.close());
  await assert.rejects(badWindow.browser.login(), { code: 'login' });
  const h = harness({ cookieFailure: true }); t.after(() => h.browser.close());
  await assert.rejects(h.browser.persist(), error => {
    assert.equal(error.code, 'session'); assert.ok(!JSON.stringify(safeError(error)).includes('private')); return true;
  });
  assert.equal(safeError(new Error('unrelated private failure')).code, 'operation');
  assert.ok(!safeError(new Error('unrelated private failure')).message.includes('文件权限'));
});

test('explicit completion resumes an unfamiliar Verdent callback, but never interrupts Google login', async t => {
  const h = harness(); t.after(() => h.browser.close()); await h.browser.login(); await settle();
  const contents = h.windows[0].webContents;
  contents.url = 'https://accounts.google.com/signin';
  await assert.rejects(h.browser.resume(), { code: 'auth' }); assert.equal(h.windows[0].loads.length, 1);
  contents.url = 'https://login.verdent.ai/passport/return';
  await h.browser.resume(); assert.equal(contents.getURL(), DASHBOARD);
  assert.equal(h.statuses.at(-1).phase, 'returning');
  assert.equal((await h.browser.request(IDENTITY_ENDPOINT, null)).status, 200);
});

test('closing during a callback check cannot reopen a disabled login window', async () => {
  const h = harness(); await h.browser.login(); await settle();
  const contents = h.windows[0].webContents;
  let finish;
  contents.executeJavaScript = () => new Promise(resolve => { finish = resolve; });
  contents.url = 'https://login.verdent.ai/passport/oauth/google/callback';
  contents.emit('did-finish-load'); h.browser.close(); finish(true); await settle();
  assert.equal(h.windows.length, 1); assert.equal(h.windows[0].isDestroyed(), true);
});

test('signed-in apex Dashboard is accepted and requests run in that page', async t => {
  const h = harness(); t.after(() => h.browser.close()); await h.browser.login(); await settle();
  h.windows[0].webContents.url = 'https://verdent.ai/dashboard';
  assert.equal((await h.browser.request(IDENTITY_ENDPOINT, null)).status, 200);
  assert.equal(h.windows[0].loads.length, 1);
});

test('a Dashboard opened in an OAuth popup is used instead of the stale login owner', async t => {
  const h = harness(); t.after(() => h.browser.close()); await h.browser.login(); await settle();
  const owner = h.windows[0]; owner.webContents.url = 'https://accounts.google.com/signin';
  const popup = new h.Window({}); owner.webContents.emit('did-create-window', popup);
  popup.webContents.url = DASHBOARD;
  let called = false; const execute = popup.webContents.executeJavaScript.bind(popup.webContents);
  popup.webContents.executeJavaScript = script => { called = true; return execute(script); };
  assert.equal((await h.browser.request(IDENTITY_ENDPOINT, null)).status, 200);
  assert.equal(called, true);
  await h.browser.resume(); assert.equal(owner.loads.length, 1);
});

test('refresh waits for Dashboard navigation instead of declaring login expired', async t => {
  const h = harness(); t.after(() => h.browser.close()); await h.browser.login(); await settle();
  const contents = h.windows[0].webContents; contents.loading = true;
  const request = h.browser.request(IDENTITY_ENDPOINT, null);
  await settle(); assert.equal(h.requests.length, 0);
  contents.loading = false; contents.emit('did-stop-loading');
  assert.equal((await request).status, 200);
});

test('localized Dashboard with a ready document is queryable while resources still load', async t => {
  const h = harness(); t.after(() => h.browser.close()); await h.browser.login(); await settle();
  const contents = h.windows[0].webContents;
  contents.url = 'https://www.verdent.ai/zh-CN/dashboard?private=DO_NOT_EXPOSE';
  contents.loading = true; contents.emit('dom-ready');
  assert.equal((await h.browser.request(IDENTITY_ENDPOINT, null)).status, 200);
  assert.ok(!JSON.stringify(h.statuses).includes('DO_NOT_EXPOSE'));
  contents.emit('did-start-navigation', {}, contents.url, false, true);
  const request = h.browser.request(IDENTITY_ENDPOINT, null);
  await settle(); assert.equal(h.requests.length, 1);
  contents.emit('dom-ready');
  assert.equal((await request).status, 200);
});
