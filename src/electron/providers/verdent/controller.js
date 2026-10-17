'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { VerdentStore, validRefreshMinutes } = require('./store');
const { createBrowserSession } = require('./browserSession');
const { projectHistory, historyForDisplay, statsForDisplay } = require('./history');
const { collectSnapshot, scopeForDates, historyScope, scopeKey, shiftDay, firstCreateDay, groupItems, GROUP_DIMENSIONS, TOKEN_FIELDS, summarize, ENDPOINT, IDENTITY_ENDPOINT, accountKey, successfulBody, VerdentError } = require('./usage');

function safeError(error) {
  return error instanceof VerdentError ? { code: error.code, message: error.message } : { code: 'operation', message: 'Verdent 操作未完成，原成功统计已保留；请重试或重新登录。' };
}

class VerdentController {
  constructor({ file, store = new VerdentStore(file), browserFactory, notify = () => {}, now = Date.now }) {
    this.store = store; this.browserFactory = browserFactory; this.notify = notify;
    this.sessions = new Map(); this.observedAccounts = new Map(); this.error = null; this.progress = null;
    this.projections = new WeakMap(); this.disposed = false;
    this.loginStatuses = new Map();
    this.now = now; this.lastAttemptAt = 0; this.nextRefreshAt = null; this.viewRange = null;
    this.startupPending = Boolean(store.data.enabled && store.data.activeProfile && this.collectionRange());
    this.busy = false; this.timer = null; this.operation = null; this.validation = null; this.anomalies = [];
    this.schedule();
  }
  collectionRange() {
    return historyScope(this.now());
  }
  usage() {
    const data = this.store.data;
    if (!data.enabled) return null;
    const account = this.observedAccounts.get(data.activeProfile);
    const timezone = `${Intl.DateTimeFormat().resolvedOptions().timeZone}/${new Date(this.now()).getTimezoneOffset()}`;
    const cached = this.usageCache;
    if (cached?.snapshots === data.snapshots && cached.profile === data.activeProfile && cached.account === account && cached.timezone === timezone) return cached.value;
    if (cached?.timezone !== timezone) this.projections = new WeakMap();
    const value = projectHistory(data.snapshots, data.activeProfile, account);
    this.usageCache = { snapshots: data.snapshots, profile: data.activeProfile, account, timezone, value };
    return value;
  }
  selectHistory(input) {
    this.assertIdle();
    const saved = input?.key && this.store.data.snapshots.find(s => s.profileId === this.store.data.activeProfile && scopeKey(s.scope) === input.key);
    this.viewRange = saved ? saved.scope : input ? scopeForDates(input.startDate, input.endDate) : null;
    this.emit();
  }
  browser(id = this.store.data.activeProfile) {
    if (!this.store.data.profiles.some(p => p.id === id)) throw new VerdentError('profile', '请先添加本地账号槽。');
    if (!this.sessions.has(id)) {
      try {
        this.sessions.set(id, this.browserFactory(id, status => {
          this.loginStatuses.set(id, status); this.emit();
        }));
      } catch (error) { throw new VerdentError('browser', 'Verdent 登录窗口初始化失败，请关闭应用后重新启动。', undefined, { cause: error }); }
    }
    return this.sessions.get(id);
  }
  state() {
    const data = this.store.data;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (this.projectionTimezone !== timezone) {
      this.projectionTimezone = timezone;
      this.projections = new WeakMap();
    }
    const usage = this.usage();
    const observed = this.observedAccounts.get(data.activeProfile);
    const all = data.snapshots.filter(s => s.profileId === data.activeProfile && (!observed || s.accountKey === observed));
    const range = this.collectionRange();
    const selectedScope = (this.viewRange || range) && scopeKey(this.viewRange || range);
    const candidates = all.filter(s => scopeKey(s.scope) === selectedScope).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const selected = candidates[0] || (!this.viewRange ? [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] : null);
    if (selected && !this.projections.has(selected)) this.projections.set(selected, Object.fromEntries(GROUP_DIMENSIONS.map(d => [d, groupItems(selected.items, d)])));
    return { enabled: data.enabled, intervalMinutes: data.intervalMinutes, rangeMode: 'allHistory', nextRefreshAt: this.nextRefreshAt,
      profiles: data.profiles, activeProfile: data.activeProfile, range,
      busy: this.busy, progress: this.progress, error: this.error, anomalies: this.anomalies,
      validation: this.validation, identityVerified: Boolean(observed),
      loginStatus: this.loginStatuses.get(data.activeProfile) || null,
      coverage: usage?.coverage || null, excludedSnapshots: usage?.excludedSnapshots || 0,
      history: all.map(s => ({ key: scopeKey(s.scope), kind: s.scope.kind, startDate: firstCreateDay(s.scope.start_time), endDate: firstCreateDay(s.scope.end_time), account: s.accountKey.slice(0, 10), updatedAt: s.updatedAt, totals: s.totals, total: s.total })),
      selected: selected ? { scope: selected.scope, updatedAt: selected.updatedAt, total: selected.total, fingerprint: selected.fingerprint, totals: selected.totals,
        account: selected.accountKey.slice(0, 10), comparison: selected.comparison, groups: this.projections.get(selected) } : null };
  }
  emit() { if (!this.disposed) this.notify(this.state()); }
  assertIdle() { if (this.busy) throw new VerdentError('busy', '请等待当前操作结束，或取消采集。'); }
  configure(input) {
    this.assertIdle();
    const patch = { rangeMode: 'allHistory' };
    if (Object.hasOwn(input, 'enabled')) {
      if (typeof input.enabled !== 'boolean') throw new VerdentError('settings', '开关值无效。');
      patch.enabled = input.enabled;
    }
    if (Object.hasOwn(input, 'intervalMinutes')) {
      if (!validRefreshMinutes(input.intervalMinutes)) throw new VerdentError('settings', '刷新间隔须为 1–3600 个整数秒，或设为 0 仅启动与手动刷新。');
      patch.intervalMinutes = input.intervalMinutes;
    }
    if (Object.hasOwn(input, 'rangeMode')) {
      if (!['fixed', 'today', 'last7', 'month', 'allHistory'].includes(input.rangeMode)) throw new VerdentError('settings', '采集范围模式无效。');
      // Accept old window commands, but collection always covers full history.
    }
    if (input.startDate || input.endDate) {
      scopeForDates(input.startDate, input.endDate);
    }
    if (Object.hasOwn(input, 'activeProfile')) {
      if (!this.store.data.profiles.some(p => p.id === input.activeProfile)) throw new VerdentError('profile', '账号槽不存在。');
      patch.activeProfile = input.activeProfile;
    }
    this.store.update(patch);
    this.viewRange = null;
    if (patch.activeProfile || patch.rangeMode || patch.range) this.lastAttemptAt = 0;
    if (patch.enabled === false) for (const browser of this.sessions.values()) browser.close();
    this.error = null; this.validation = null; this.anomalies = []; this.schedule(); this.emit();
  }
  addProfile(label) {
    this.assertIdle();
    if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new VerdentError('profile', '请输入 1–80 字的本地账号标签。');
    if (this.store.data.profiles.length >= 20) throw new VerdentError('profile', '最多保存 20 个本地账号槽。');
    const profile = { id: crypto.randomUUID(), label: label.trim() };
    this.store.update({ profiles: [...this.store.data.profiles, profile], activeProfile: profile.id });
    this.lastAttemptAt = 0; this.viewRange = null; this.error = null; this.schedule(); this.emit();
  }
  async login() {
    this.assertIdle();
    if (!this.store.data.enabled) throw new VerdentError('disabled', '请先启用 Verdent。');
    await this.browser().login();
    this.error = null; this.emit();
  }
  async completeLogin() {
    this.assertIdle();
    if (!this.store.data.enabled) throw new VerdentError('disabled', '请先启用 Verdent。');
    await this.browser().resume();
    return this.refresh();
  }
  async clearSession() {
    this.assertIdle();
    await this.browser().clear(); this.observedAccounts.delete(this.store.data.activeProfile);
    this.error = { code: 'auth', message: '本地登录态已清除，历史仍保留。请重新登录。' }; this.schedule(); this.emit();
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRefreshAt = null;
    if (this.disposed) return;
    const { enabled, intervalMinutes, activeProfile } = this.store.data;
    const range = this.collectionRange();
    if (!this.busy && enabled && (intervalMinutes || this.startupPending) && activeProfile && range && this.error?.code !== 'auth') {
      const lastSuccess = this.store.data.snapshots.filter(s => s.profileId === activeProfile && scopeKey(s.scope) === scopeKey(range))
        .reduce((latest, snapshot) => Math.max(latest, Date.parse(snapshot.updatedAt)), 0);
      const delay = this.startupPending ? 0 : Math.max(0, Math.max(this.lastAttemptAt, lastSuccess) + intervalMinutes * 60000 - this.now());
      this.nextRefreshAt = this.now() + delay;
      this.timer = setTimeout(() => { this.refresh().catch(error => { this.error = safeError(error); this.emit(); }); }, delay);
      this.timer.unref?.();
    }
  }
  wake() { this.schedule(); this.emit(); }
  refreshFromApp() {
    if (this.disposed || !this.store.data.enabled || !this.store.data.activeProfile || !this.collectionRange()) return;
    void this.refresh().catch(error => { this.error = safeError(error); this.emit(); });
  }
  cancel() { this.operation?.abort(); }
  async run(task) {
    this.assertIdle();
    if (this.disposed) throw new VerdentError('closed', 'Verdent 已关闭。');
    if (!this.store.data.enabled) throw new VerdentError('disabled', '请先启用 Verdent。');
    this.busy = true; this.error = null; this.anomalies = []; clearTimeout(this.timer); this.nextRefreshAt = null;
    this.startupPending = false;
    this.operation = new AbortController(); this.emit();
    try { await task(this.operation.signal); }
    catch (error) { this.error = safeError(error); this.anomalies = error.anomalies || []; }
    finally { this.lastAttemptAt = this.now(); this.busy = false; this.progress = null; this.operation = null; this.schedule(); this.emit(); }
    return this.state();
  }
  options(signal) {
    const range = this.collectionRange();
    if (!range) throw new VerdentError('range', '请先保存日期范围。');
    return { ...range, signal, request: (url, body, signal) => this.browser().request(url, body, signal), progress: progress => { this.progress = progress; this.emit(); } };
  }
  async refresh({ forceFull = false } = {}) {
    if (this.busy) return this.state();
    this.viewRange = null;
    return this.run(async signal => {
      const id = this.store.data.activeProfile;
      const opts = this.options(signal);
      // Identity is checked before reading history from this slot into the view.
      const key = accountKey(await opts.request(IDENTITY_ENDPOINT, null, signal));
      this.observedAccounts.set(id, key); this.emit();
      const previous = this.store.data.snapshots.filter(snapshot => snapshot.profileId === id && snapshot.accountKey === key
        && snapshot.scope.start_time <= opts.start_time && snapshot.scope.end_time <= opts.end_time)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      // A newer overlapping range may have corrected a cached older day.
      // Reconcile fully before giving an old tail a new range timestamp.
      const competingHistory = previous && this.store.data.snapshots.some(snapshot => snapshot !== previous
        && snapshot.profileId === id && snapshot.accountKey === key
        && snapshot.scope.start_time <= opts.end_time && snapshot.scope.end_time >= opts.start_time
        && Date.parse(snapshot.updatedAt) > Date.parse(previous.fullReadAt || previous.updatedAt));
      const snapshot = await collectSnapshot({ ...opts, previous, forceFull: forceFull || competingHistory });
      signal.throwIfAborted();
      if (key !== snapshot.accountKey) throw new VerdentError('accountChanged', '账号发生变化，请重新刷新。');
      await this.browser().persist?.();
      signal.throwIfAborted();
      this.store.replace(id, snapshot);
      this.loginStatuses.set(id, { phase: 'authenticated', message: 'Verdent 登录已通过身份接口验证，用量已更新。' });
      this.validation = null;
    });
  }
  async validateWeek() {
    return this.run(async signal => {
      const opts = { ...this.options(signal), ...(this.viewRange || scopeForDates(shiftDay(firstCreateDay(this.now() / 1000), -6), firstCreateDay(this.now() / 1000))) };
      delete opts.kind;
      const scope = scopeForDates(opts.startDate, opts.endDate);
      if (shiftDay(scope.startDate, 6) !== scope.endDate) throw new VerdentError('range', '此验证需要恰好 7 天的范围。');
      const wholeBefore = await collectSnapshot(opts);
      const singles = [];
      for (let offset = 0; offset < 7; offset++) {
        const day = shiftDay(scope.startDate, offset);
        const single = await collectSnapshot({ ...opts, startDate: day, endDate: day });
        if (single.accountKey !== wholeBefore.accountKey) throw new VerdentError('accountChanged', '验证期间账号发生变化。');
        singles.push(single);
      }
      const wholeAfter = await collectSnapshot(opts);
      const totals = summarize(singles.flatMap(s => s.items));
      const fields = [...TOKEN_FIELDS, 'total_credits'];
      const stable = wholeBefore.fingerprint === wholeAfter.fingerprint && wholeBefore.accountKey === wholeAfter.accountKey;
      const sumsMatch = fields.every(f => Math.abs(totals[f] - wholeAfter.totals[f]) <= (f === 'total_credits' ? 1e-8 : 0));
      const browser = this.browser();
      let sessionTransport;
      try {
        const identity = accountKey(await browser.request(IDENTITY_ENDPOINT, null, signal, 'session'));
        const page = successfulBody(await browser.request(ENDPOINT, { team_id: '0', consume_type: '', start_time: scope.start_time, end_time: scope.end_time, page: 1, page_size: 10 }, signal, 'session'));
        sessionTransport = identity === wholeAfter.accountKey && Array.isArray(page.items) && page.page === 1 && page.page_size === 10 ? '成功（同一 Electron partition）' : '响应未通过验证';
      } catch (_) { sessionTransport = '未成功；生产采集继续使用 Dashboard 的 fetch'; }
      this.validation = { checkedAt: new Date().toISOString(), stable, sumsMatch, weekly: wholeAfter.totals, dailySum: totals, sessionTransport,
        daily: singles.map(s => ({ date: s.scope.startDate, totals: s.totals, total: s.total })) };
      // Diagnostic queries never commit a partial set of daily snapshots.
    });
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); this.cancel(); for (const browser of this.sessions.values()) browser.close(); }
}

function installVerdent({ app, BrowserWindow, session, ipcMain, powerMonitor, onUsageChanged = () => {} }) {
  let page;
  let controller;
  let startupError;
  let lastUsage;
  const subscribers = new Set();
  const rendererUrl = file => require('node:url').pathToFileURL(path.join(__dirname, '../../renderer', file)).href;
  const commandPages = new Set(['index.html', 'verdent.html'].map(rendererUrl));
  const trustedContents = contents => !contents.isDestroyed() && commandPages.has(contents.getURL().split('?')[0]);
  try {
    controller = new VerdentController({ file: path.join(app.getPath('userData'), 'verdent-usage.json'),
      browserFactory: (profileId, onStatus) => createBrowserSession({ BrowserWindow, session, profileId, onStatus }),
      notify: state => {
        for (const contents of subscribers) {
          if (trustedContents(contents)) contents.send('verdent:state', state);
          else subscribers.delete(contents);
        }
        const usage = controller?.usage();
        if (usage !== lastUsage) { lastUsage = usage; onUsageChanged(); }
      } });
  } catch (error) { startupError = error.message; }
  const pagePath = path.join(__dirname, '../../renderer/verdent.html');
  const allowed = event => trustedContents(event.sender) && event.senderFrame === event.sender.mainFrame;
  ipcMain.handle('verdent:open', event => {
    const source = event.senderFrame?.url;
    const allowedPages = ['index.html', 'dashboard.html'].map(file => require('node:url').pathToFileURL(path.join(__dirname, '../../renderer', file)).href);
    if (!allowedPages.includes(source?.split('?')[0])) return false;
    if (page && !page.isDestroyed()) { page.show(); page.focus(); return true; }
    page = new BrowserWindow({ title: 'Verdent 用量 — Token Monitor', width: 1160, height: 880, minWidth: 760, minHeight: 600,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    page.webContents.on('will-navigate', event => event.preventDefault());
    page.loadFile(pagePath);
    return true;
  });
  ipcMain.handle('verdent:command', async (event, command, input) => {
    if (!allowed(event)) return { error: { code: 'ipc', message: '无效来源。' } };
    subscribers.add(event.sender);
    if (!controller) return { error: { code: 'storage', message: startupError } };
    try {
      switch (command) {
        case 'get': break;
        case 'configure': controller.configure(input || {}); break;
        case 'selectHistory': controller.selectHistory(input); break;
        case 'addProfile': controller.addProfile(input); break;
        case 'login': await controller.login(); break;
        case 'completeLogin': return await controller.completeLogin();
        case 'clearSession': await controller.clearSession(); break;
        case 'refresh': return await controller.refresh();
        case 'refreshFull': return await controller.refresh({ forceFull: true });
        case 'validateWeek': return await controller.validateWeek();
        case 'cancel': controller.cancel(); break;
        default: throw new VerdentError('command', '未知操作。');
      }
      return controller.state();
    } catch (error) { return { ...controller.state(), error: safeError(error) }; }
  });
  const wake = () => controller?.wake();
  powerMonitor?.on('resume', wake);
  return { refresh: () => controller?.refreshFromApp(), revision: () => controller?.usage() ? `${controller.usage().revision}:${firstCreateDay(Date.now() / 1000)}` : '',
    projectStats: stats => statsForDisplay(stats, controller?.usage()), projectHistory: history => historyForDisplay(history, controller?.usage()),
    dispose: () => {
    powerMonitor?.removeListener('resume', wake); subscribers.clear();
    controller?.dispose(); if (page && !page.isDestroyed()) page.destroy();
  } };
}

module.exports = { VerdentController, installVerdent, safeError };
