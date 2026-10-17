'use strict';

// Exercise the real Chromium navigation/JS/persistence path with a synthetic
// OAuth response. All HTTPS traffic in this unique partition is intercepted.
const path = require('node:path');
const fs = require('node:fs');
const reportFile = path.resolve(__dirname, '../tmp/verdent-login-smoke-result.json');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
  const result = spawnSync(require('electron'), [__filename], { stdio: 'inherit', windowsHide: true, timeout: 45000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { ok: false };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(result.error || !report.ok ? 1 : result.status || 0);
}

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { app, BrowserWindow, session } = require('electron');
const { createBrowserSession, DASHBOARD } = require('../src/electron/providers/verdent/browserSession');
const { VerdentController, safeError } = require('../src/electron/providers/verdent/controller');
const { VerdentStore } = require('../src/electron/providers/verdent/store');
const { ENDPOINT, IDENTITY_ENDPOINT } = require('../src/electron/providers/verdent/usage');
const temporary = path.resolve(__dirname, '../tmp/verdent-login-smoke');
fs.mkdirSync(temporary, { recursive: true });
app.setPath('userData', temporary);
const timeout = setTimeout(() => { fs.writeFileSync(reportFile, JSON.stringify({ ok: false, error: 'timeout' })); app.exit(1); }, 35000);

app.whenReady().then(async () => {
  let controller;
  let browser;
  const report = { ok: false };
  try {
    const store = new VerdentStore(path.join(temporary, `usage-${crypto.randomUUID()}.json`));
    const statuses = [];
    const requests = [];
    const callback = 'https://login.verdent.ai/passport/oauth/google/callback';
    controller = new VerdentController({ store, browserFactory: (profileId, onStatus) => {
      const partition = session.fromPartition(`persist:verdent-${profileId}`);
      partition.protocol.handle('https', async request => {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');
        const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ['https://verdent.ai', new URL(DASHBOARD).origin].includes(origin) ? origin : new URL(DASHBOARD).origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
        if (request.url === IDENTITY_ENDPOINT) return new Response(JSON.stringify({ errCode: 0, data: { user_id: 'synthetic-oauth-fixture' } }), { headers });
        if (request.url === ENDPOINT) {
          const body = await request.json(); requests.push(body.page);
          return new Response(JSON.stringify({ errCode: 0, data: { page: body.page, page_size: 10, total: 1, items: [{ feature: 'Main Agent', model_name: 'unknown-fixture-model', platform: 'Verdent', source: 'verdent', business_sub_type: 'eco_mode', subagent_type: '', first_create_time: new Date('2026-10-16T09:00:01').getTime() / 1000, total_input_tokens: 4500, total_output_tokens: 1000, total_cache_read_tokens: 300000, total_cache_creation_tokens: 0, total_tokens: 305500, total_credits: 0 }] } }), { headers });
        }
        if (url.origin + url.pathname === callback) return new Response('{"errCode":0,"errMsg":"","data":null}', { headers });
        if (['https://verdent.ai', new URL(DASHBOARD).origin].includes(url.origin)) return new Response('<!doctype html><title>Verdent synthetic Dashboard</title><p>OAuth navigation fixture</p>', { headers: { 'Content-Type': 'text/html' } });
        return new Response('blocked by synthetic fixture', { status: 404 });
      });
      browser = createBrowserSession({ BrowserWindow, session, profileId, onStatus: status => { statuses.push(status); onStatus(status); } });
      return browser;
    } });
    controller.addProfile('Synthetic OAuth regression');
    controller.configure({ enabled: true, intervalMinutes: 0, startDate: '2026-10-10', endDate: '2026-10-16' });
    await controller.login();
    const win = BrowserWindow.getAllWindows()[0];
    await new Promise(resolve => { if (!win.webContents.isLoadingMainFrame()) resolve(); else win.webContents.once('did-finish-load', resolve); });
    await win.loadURL(callback);
    for (let attempt = 0; attempt < 100 && statuses.at(-1)?.phase !== 'dashboard'; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(win.webContents.getURL(), DASHBOARD);
    assert.equal(statuses.at(-1)?.phase, 'dashboard');
    const state = await controller.refresh();
    assert.equal(state.error, null);
    assert.equal(state.selected.totals.total_tokens, 305500);
    assert.equal(state.selected.totals.total_credits, 0);
    assert.equal(state.selected.groups.first_create_date[0].name, '2026-10-16');
    assert.deepEqual(requests, [1, 1]);
    await win.loadURL('https://verdent.ai/dashboard');
    const apexState = await controller.refresh();
    assert.equal(apexState.error, null);
    assert.equal(apexState.selected.totals.total_tokens, 305500);
    const popupCreated = new Promise(resolve => win.webContents.once('did-create-window', resolve));
    await win.webContents.executeJavaScript('window.open("https://www.verdent.ai/zh-CN/dashboard"); void 0;');
    const popup = await popupCreated;
    await new Promise(resolve => { if (!popup.webContents.isLoadingMainFrame()) resolve(); else popup.webContents.once('did-finish-load', resolve); });
    await win.loadURL('https://accounts.google.com/signin');
    const popupState = await controller.refresh();
    assert.equal(popupState.error, null);
    assert.equal(popupState.selected.totals.total_tokens, 305500);
    assert.deepEqual(requests, [1, 1, 1, 1, 1, 1]);
    report.ok = true; report.callbackRecovered = true; report.identityVerified = state.identityVerified;
    report.apexDashboard = true; report.localizedPopupDashboard = true;
    report.tokens = state.selected.totals.total_tokens; report.credits = state.selected.totals.total_credits;
    report.firstCreateDate = state.selected.groups.first_create_date[0].name;
    report.readPages = requests;
    report.persistedSnapshots = new VerdentStore(store.file).data.snapshots.length;
  } catch (error) { report.error = safeError(error); }
  finally {
    clearTimeout(timeout); controller?.dispose(); browser?.close();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); app.exit(report.ok ? 0 : 1);
  }
});
