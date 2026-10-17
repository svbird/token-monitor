'use strict';

// Real application smoke test; synthetic local profile, no Verdent network calls.
if (!process.versions.electron) {
  const path = require('node:path');
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const report = path.resolve(__dirname, '../tmp/verdent-smoke-result.json');
  if (fs.existsSync(report)) fs.unlinkSync(report);
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true, timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  const state = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : { error: 'Missing smoke report' };
  process.exit(result.error || state.error ? 1 : result.status || 0);
}
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const temporary = path.join(root, 'tmp');
fs.mkdirSync(temporary, { recursive: true });
app.setPath('userData', path.join(temporary, 'verdent-smoke-data'));
const { VerdentStore } = require('../src/electron/providers/verdent/store');
const { scopeForDates, summarize, fingerprint } = require('../src/electron/providers/verdent/usage');
const p = crypto.randomUUID();
const item = { feature: 'Main Agent', model_name: 'synthetic-model-a', platform: 'Verdent', source: 'verdent', business_sub_type: 'eco_mode', subagent_type: '', first_create_time: new Date('2026-10-16T09:00:01').getTime() / 1000, total_cache_read_tokens: 300000, total_cache_creation_tokens: 0, total_input_tokens: 4500, total_output_tokens: 1000, total_tokens: 305500, total_credits: 0 };
const store = new VerdentStore(path.join(app.getPath('userData'), 'verdent-usage.json'));
store.update({ enabled: false, rangeMode: 'fixed', intervalMinutes: 0, profiles: [{ id: p, label: '离线预览 · 两条样本' }], activeProfile: p, snapshots: [], range: scopeForDates('2026-10-10', '2026-10-16') });
const items = [item, { ...item, feature: 'Enhancement', subagent_type: 'Manager Enhancement', first_create_time: new Date('2026-10-16T09:00:02').getTime() / 1000, total_cache_read_tokens: 250, total_input_tokens: 7000, total_output_tokens: 500, total_tokens: 7750 }];
store.replace(p, { scope: store.data.range, accountKey: 'a'.repeat(64), items, total: 2, pages: 1, totals: summarize(items), fingerprint: fingerprint(items), updatedAt: new Date().toISOString(), consistency: 'two-equal-reads' });
let finished = false;
let settingsResult;
let managementResult;
let mainWindow;
const finish = (result, code = 0) => { if (finished) return; finished = true; fs.writeFileSync(path.join(temporary, 'verdent-smoke-result.json'), JSON.stringify(result, null, 2)); process.exitCode = code; app.quit(); };
setTimeout(() => finish({ error: 'smoke timeout' }, 1), 45000).unref();
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', async () => {
    const url = win.webContents.getURL();
    if (url.split('?')[0].endsWith('/renderer/index.html')) {
      try {
        mainWindow = win;
        await new Promise(resolve => setTimeout(resolve, 500));
        settingsResult = await win.webContents.executeJavaScript(`(async () => {
          document.querySelector('#settingsButton').click();
          document.querySelector('[data-settings-section="general"]').click();
          document.querySelector('[data-settings-section="verdent"]').click();
          const input = document.querySelector('#verdentEnabled'); input.checked = true; input.dispatchEvent(new Event('change'));
          await new Promise(resolve => setTimeout(resolve, 150));
          const config = await window.tokenMonitor.verdentCommand('get');
          return { expanded: document.querySelector('[data-settings-section="verdent"]').getAttribute('aria-expanded'), generalCollapsed: document.querySelector('[data-settings-section="general"]').getAttribute('aria-expanded'), enabled: config.enabled, compact: !document.querySelector('#verdentInterval') && !document.querySelector('#verdentProfile') };
        })()`);
        if (settingsResult.expanded !== 'true' || settingsResult.generalCollapsed !== 'false' || !settingsResult.enabled || !settingsResult.compact) throw new Error('Native settings assertions failed');
        win.show(); win.focus();
        const aggregation = await win.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 100 && !state.stats?.periods?.allTime; i++) await new Promise(resolve => setTimeout(resolve, 100));
          state.period = 'allTime'; state.breakdown = 'tool';
          document.querySelector('#settingsButton').click();
          renderRows(toolRowsForPeriod(state.stats.periods.allTime));
          const tool = toolRowsForPeriod(state.stats.periods.allTime).find(row => row.key === 'verdent');
          const model = modelRowsForPeriod(state.stats.periods.allTime).find(row => row.key === 'synthetic-model-a[eco]' );
          const row = document.querySelector('[data-key="verdent"]');
          const history = await window.tokenMonitor.getDashboardHistory();
          const day = history.daily.find(row => row.date === '2026-10-16');
          return { toolTokens: tool?.value, toolCredits: tool?.credits, subtitle: tool?.subtitle, ecoModel: model?.name, renderedCost: row?.querySelector('.cost')?.textContent || row?.querySelector('.row-cost')?.textContent, modelCredits: model?.credits, historyTokens: day?.perClient?.verdent?.tokens, historyCredits: day?.verdentCredits, totalsIncludeVerdent: state.stats.periods.allTime.totalTokens >= 313250, sessionInvented: rawSessionRowsForPeriod(state.stats.periods.allTime).some(row => row.client === 'verdent'), projectInvented: projectRowsForPeriod(state.stats.periods.allTime).some(row => row.clients?.includes('verdent')) };
        })()`);
        if (aggregation.subtitle !== '' || aggregation.ecoModel !== 'synthetic-model-a[eco]' || aggregation.toolTokens !== 313250 || aggregation.toolCredits !== 0 || aggregation.modelCredits !== 0 || aggregation.historyTokens !== 313250 || aggregation.historyCredits !== 0 || !aggregation.totalsIncludeVerdent || aggregation.sessionInvented || aggregation.projectInvented || aggregation.renderedCost !== '0 Credits') throw new Error('Aggregation assertions failed: ' + JSON.stringify(aggregation));
        settingsResult.aggregation = aggregation;
        await win.webContents.executeJavaScript('document.querySelector("#verdentOpen").click()');
      } catch (error) { finish({ error: error.message }, 1); }
    }
    if (url.endsWith('/renderer/dashboard.html')) {
      try {
        const dashboard = await win.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 100 && !state.history; i++) await new Promise(resolve => setTimeout(resolve, 100));
          state.tab = 'activity'; renderNow();
          const card = document.querySelector('[data-stat="verdentCredits"] .dash-card-v');
          const day = state.dayMap.get('2026-10-16');
          return { creditsCard: card?.textContent, dayCredits: day?.verdentCredits, hasVerdentHistory: state.history.daily.some(row => row.perClient?.verdent?.tokens === 313250), hasHeatmap: document.querySelectorAll('#dashHeatmap [data-d]').length > 0 };
        })()`);
        if (dashboard.creditsCard !== '0 Credits' || dashboard.dayCredits !== 0 || !dashboard.hasVerdentHistory || !dashboard.hasHeatmap) throw new Error('Dashboard assertions failed: ' + JSON.stringify(dashboard));
        finish({ ...managementResult, dashboard });
      } catch (error) { finish({ error: error.message }, 1); }
    }
    if (url.endsWith('/renderer/verdent.html')) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const result = await win.webContents.executeJavaScript(`(async () => {
          const state = await window.verdent.command('get');
          return { selectedTokens: state.selected?.totals.total_tokens, cards: [...document.querySelectorAll('#cards strong')].map(el => el.textContent), historyRows: document.querySelectorAll('#history tr').length, groups: document.querySelector('#groups').textContent, nodeAccess: typeof require, enabled: document.querySelector('#enabled').checked, error: document.querySelector('#error').textContent };
        })()`);
        if (result.selectedTokens !== 313250 || result.nodeAccess !== 'undefined' || result.historyRows !== 1 || result.error) throw new Error('UI assertions failed');
        await win.webContents.executeJavaScript(`document.querySelector('#dimension').value = 'subagent_type'; document.querySelector('#dimension').dispatchEvent(new Event('change'));`);
        result.emptySubagent = await win.webContents.executeJavaScript(`document.querySelector('#groups').textContent.includes('（空值）')`);
        if (!result.emptySubagent) throw new Error('Empty subagent assertion failed');
        const settingsState = await win.webContents.executeJavaScript(`(async () => {
          if (document.querySelector('#interval').value !== '0') throw new Error('Settings did not reach usage window');
          return window.verdent.command('configure', { intervalMinutes: 60 });
        })()`);
        if (settingsState.intervalMinutes !== 60) throw new Error('Shared interval save failed');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await mainWindow.webContents.executeJavaScript('document.querySelector("#verdentCollectionStatus").textContent.includes("60")')) throw new Error('Usage window did not update native settings');
        result.settings = { ...settingsResult, bidirectionalSync: true };
        if (process.argv.includes('--screenshot')) {
          win.show(); win.focus();
          fs.writeFileSync(path.join(temporary, 'verdent-ui.png'), (await win.capturePage(undefined, { stayHidden: false, stayAwake: true })).toPNG());
          result.screenshot = 'tmp/verdent-ui.png';
        } else result.screenshot = 'not-requested';
        managementResult = result;
        await mainWindow.webContents.executeJavaScript('window.tokenMonitor.openDashboard()');
      } catch (error) { finish({ error: error.message }, 1); }
    }
  });
});
require(path.join(root, 'src/electron/main'));
