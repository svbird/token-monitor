'use strict';

const { ENDPOINT, IDENTITY_ENDPOINT, VerdentError } = require('./usage');
const DASHBOARD = 'https://www.verdent.ai/dashboard';
const DASHBOARD_ORIGIN = new URL(DASHBOARD).origin;
const SITE_ORIGINS = new Set([DASHBOARD_ORIGIN, 'https://verdent.ai']);

function isSitePage(contents) {
  try { return !contents.isDestroyed() && safeNavigation(contents.getURL()) && SITE_ORIGINS.has(new URL(contents.getURL()).origin); }
  catch (_) { return false; }
}

function safeNavigation(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password; } catch (_) { return false; }
}

function isOAuthResponseUrl(url) {
  try {
    const parsed = new URL(url);
    return safeNavigation(url) && ['https://login.verdent.ai', 'https://api.verdent.ai'].includes(parsed.origin)
      && parsed.pathname.startsWith('/passport/oauth/');
  } catch (_) { return false; }
}

// Return a boolean only: never transfer callback text, query, code or token.
const AUTH_SUCCESS_SCRIPT = `(() => {
  if (!['application/json', 'text/plain', 'text/html'].includes(document.contentType)) return false;
  const text = (document.querySelector('pre')?.textContent || document.body?.textContent || '').trim();
  if (text.length > 4096) return false;
  try {
    const body = JSON.parse(text);
    return body?.errCode === 0 && body.data === null;
  } catch (_) { return false; }
})()`;

function createBrowserSession({ BrowserWindow, session, profileId, onStatus = () => {} }) {
  const partition = session.fromPartition(`persist:verdent-${profileId}`);
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on('will-download', event => event.preventDefault());
  let window;
  let loading = null;
  let recovery = null;
  const failedLoads = new WeakSet();
  const readyDocuments = new WeakSet();
  let generation = 0;
  const popups = new Set();
  const status = (phase, message) => onStatus({ phase, message });

  function load(win, url) {
    failedLoads.delete(win.webContents);
    const pending = win.loadURL(url).catch(error => {
      // Interactive navigation can supersede loadURL. Do not retain a rejected
      // initial-load promise and fail every later login/refresh with that error.
      if (error.code === 'ERR_ABORTED' || error.errno === -3) return;
      failedLoads.add(win.webContents);
      status('error', 'Verdent 页面加载失败，请检查网络后重新打开登录窗口。');
      throw new VerdentError('network', 'Verdent 登录页面加载失败，请检查网络后重试。', undefined, { cause: error });
    });
    loading = pending;
    pending.then(() => { if (loading === pending) loading = null; }, () => { if (loading === pending) loading = null; });
    return pending;
  }

  async function recoverCallback(contents) {
    if (contents.isDestroyed() || !isOAuthResponseUrl(contents.getURL())) return false;
    if (recovery) return recovery;
    const ticket = generation;
    const pending = (async () => {
      let success;
      try { success = await contents.executeJavaScript(AUTH_SUCCESS_SCRIPT); }
      catch (error) { throw new VerdentError('login', '无法检查 Verdent 登录回调，请重新打开登录窗口。', undefined, { cause: error }); }
      if (!success || ticket !== generation || contents.isDestroyed()) return false;
      status('returning', '正在从登录回调返回 Verdent Dashboard…');
      const target = window && !window.isDestroyed() ? window : createWindow(false);
      // A null-data success envelope signals navigation, not authentication.
      // The real identity API must still succeed before any usage is accepted.
      await load(target, DASHBOARD);
      if (ticket !== generation || target.isDestroyed()) return false;
      partition.flushStorageData();
      await partition.cookies.flushStore();
      if (contents !== target.webContents) BrowserWindow.fromWebContents(contents)?.close();
      status('dashboard', '已返回 Verdent 页面，请点击“刷新完整范围”验证登录并读取用量。');
      return true;
    })();
    recovery = pending;
    try { return await pending; }
    catch (error) {
      if (error instanceof VerdentError) throw error;
      throw new VerdentError('session', 'Verdent 回调已完成，但浏览器会话保存失败，请重新登录后重试。', undefined, { cause: error });
    } finally { if (recovery === pending) recovery = null; }
  }

  function secure(contents) {
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) readyDocuments.delete(contents);
    });
    contents.on('dom-ready', () => {
      readyDocuments.add(contents);
      failedLoads.delete(contents);
      if (isSitePage(contents)) status('page', `已打开 Verdent 页面（${new URL(contents.getURL()).origin}），可刷新以核对登录和用量。`);
    });
    contents.on('will-navigate', (event, url) => { if (!safeNavigation(url)) event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!safeNavigation(url)) event.preventDefault(); });
    contents.setWindowOpenHandler(({ url }) => safeNavigation(url) || url === 'about:blank'
      ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, preload: undefined } } }
      : { action: 'deny' });
    contents.on('did-create-window', popup => {
      popups.add(popup); secure(popup.webContents); popup.on('closed', () => popups.delete(popup));
    });
    contents.on('did-finish-load', () => {
      failedLoads.delete(contents);
      recoverCallback(contents).catch(error => status('error', error.message));
    });
    contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        failedLoads.add(contents);
        status('error', `Verdent 登录页面加载失败（网络错误 ${errorCode}），请重新打开登录窗口。`);
      }
    });
  }

  function createWindow(show) {
    const win = new BrowserWindow({ title: 'Verdent 登录 — Token Monitor', width: 1100, height: 820, show,
      webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window = win;
    secure(win.webContents);
    return win;
  }

  function siteWindow() {
    const candidates = [...popups].reverse().concat(window || []).filter(win => !win.isDestroyed() && isSitePage(win.webContents));
    // Prefer the completed popup over an owner left at the website's login page.
    return candidates.find(win => /(?:^|\/)dashboard(?:\/|$)/.test(new URL(win.webContents.getURL()).pathname)) || candidates[0];
  }

  async function waitForPage(contents, signal) {
    signal?.throwIfAborted();
    if (readyDocuments.has(contents) || !contents.isLoadingMainFrame()) return;
    status('loading', '正在等待 Verdent 页面加载完成…');
    await new Promise((resolve, reject) => {
      let timer;
      const finish = error => {
        clearTimeout(timer);
        contents.removeListener('did-stop-loading', ready);
        contents.removeListener('dom-ready', ready);
        contents.removeListener('destroyed', closed);
        signal?.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve();
      };
      const ready = () => finish();
      const closed = () => finish(new VerdentError('auth', 'Verdent 登录窗口已关闭，请重新打开登录。'));
      const cancelled = () => finish(new VerdentError('cancelled', '采集已取消。'));
      contents.once('did-stop-loading', ready);
      contents.once('dom-ready', ready);
      contents.once('destroyed', closed);
      signal?.addEventListener('abort', cancelled, { once: true });
      timer = setTimeout(() => finish(new VerdentError('timeout', 'Verdent 页面仍在加载，请稍后刷新；原成功统计已保留。')), 20000);
      if (contents.isDestroyed()) closed();
      else if (signal?.aborted) cancelled();
      else if (readyDocuments.has(contents) || !contents.isLoadingMainFrame()) ready();
    });
  }

  async function ensure(signal) {
    // OAuth may finish in a child window while the original remains at Google.
    let target = siteWindow();
    if (target) {
      await waitForPage(target.webContents, signal);
      if (isSitePage(target.webContents) && !failedLoads.has(target.webContents)) return target;
    }
    if (!window || window.isDestroyed()) await load(createWindow(false), DASHBOARD);
    if (recovery) await recovery;
    else {
      await loading;
      await recoverCallback(window.webContents);
    }
    if (!window || window.isDestroyed()) throw new VerdentError('auth', 'Verdent 登录窗口已关闭，请重新打开登录。');
    target = siteWindow() || window;
    await waitForPage(target.webContents, signal);
    if (failedLoads.has(target.webContents)) throw new VerdentError('network', 'Verdent 页面加载失败，请重新打开登录窗口。');
    target = siteWindow();
    if (!target) throw new VerdentError('auth', '尚未找到可查询的 Verdent 官网窗口，请在登录窗口完成登录后刷新。');
    await waitForPage(target.webContents, signal);
    if (!isSitePage(target.webContents)) throw new VerdentError('auth', 'Verdent 窗口已跳转，请返回仪表盘后刷新。');
    return target;
  }

  async function login() {
    try {
      status('waiting', '请在 Verdent 窗口完成登录；Google 回调完成后会自动返回 Dashboard。');
      if (!window || window.isDestroyed()) {
        load(createWindow(true), DASHBOARD).catch(() => {});
      } else {
        window.show(); window.focus();
        if (failedLoads.has(window.webContents)) load(window, DASHBOARD).catch(() => {});
        else await recoverCallback(window.webContents);
      }
      // Opening a login window does not require interactive OAuth to be done.
    } catch (error) {
      if (error instanceof VerdentError) throw error;
      throw new VerdentError('login', 'Verdent 登录窗口未能打开，请重试登录。', undefined, { cause: error });
    }
  }

  async function resume() {
    const ready = siteWindow();
    if (ready) {
      await waitForPage(ready.webContents);
      status('checking', '正在通过 Verdent 身份与用量接口验证登录…');
      return;
    }
    if (!window || window.isDestroyed()) throw new VerdentError('auth', '请先打开 Verdent 窗口并完成登录。');
    if (recovery) await recovery;
    let origin;
    try { origin = new URL(window.webContents.getURL()).origin; } catch (_) {}
    if (![...SITE_ORIGINS, 'https://login.verdent.ai', 'https://api.verdent.ai'].includes(origin)) throw new VerdentError('auth', '当前仍在第三方登录页面，请先完成 Google 登录。');
    status('returning', '正在返回 Dashboard 并验证登录…');
    await load(window, DASHBOARD);
    // No success claim here: the caller must query the identity/usage APIs.
  }

  async function request(url, body, signal, mode = 'dashboard') {
    if (![ENDPOINT, IDENTITY_ENDPOINT].includes(url)) throw new VerdentError('transport', '不支持的 Verdent 接口。');
    signal?.throwIfAborted();
    let timer;
    let onAbort;
    try {
      const abort = new Promise((_, reject) => {
        onAbort = () => reject(new VerdentError('cancelled', '采集已取消。'));
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => reject(new VerdentError('timeout', 'Verdent 请求超时，保留上次结果。')), 30000);
      });
      const work = (async () => {
        const win = await ensure(signal);
        if (mode === 'session') {
          const reply = await partition.fetch(url, { method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'error',
            headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
          return { status: reply.status, body: await reply.json().catch(() => null) };
        }
        return win.webContents.executeJavaScript(`(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 25000);
          try {
            const response = await fetch(${JSON.stringify(url)}, {
              method: ${JSON.stringify(body ? 'POST' : 'GET')}, credentials: 'include', redirect: 'error',
              headers: { 'Content-Type': 'application/json' },
              ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
              signal: controller.signal
            });
            return { status: response.status, body: await response.json().catch(() => null) };
          } finally { clearTimeout(timer); }
        })()`);
      })();
      return await Promise.race([work, abort]);
    } catch (error) {
      if (error instanceof VerdentError) throw error;
      throw new VerdentError('network', 'Verdent 页面或网络请求失败；请检查网络、登录及 Dashboard 是否已加载。', undefined, { cause: error });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }

  function close() {
    generation++;
    for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
    if (window && !window.isDestroyed()) window.destroy();
    window = null; loading = null;
  }
  return { request, login, resume, close,
    async persist() {
      try { partition.flushStorageData(); await partition.cookies.flushStore(); }
      catch (error) { throw new VerdentError('session', 'Verdent 浏览器会话保存失败，请重新登录后重试。', undefined, { cause: error }); }
    },
    async clear() {
      try { close(); await partition.clearStorageData(); await partition.clearCache(); await partition.cookies.flushStore(); }
      catch (error) { throw new VerdentError('session', 'Verdent 浏览器会话清除失败，请关闭应用后重试。', undefined, { cause: error }); }
    } };
}

module.exports = { DASHBOARD, AUTH_SUCCESS_SCRIPT, safeNavigation, isOAuthResponseUrl, createBrowserSession };
