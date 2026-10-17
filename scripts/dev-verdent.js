'use strict';

// Launch with: node_modules/.bin/electron scripts/dev-verdent.js
// The real Token Monitor entry point, isolated from an installed app's userData.
const { app } = require('electron');
const path = require('node:path');
app.setPath('userData', path.resolve(__dirname, '../tmp/verdent-desktop'));
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    if (process.argv.includes('--login') && window.webContents.getURL().split('?')[0].endsWith('/renderer/index.html')) {
      window.webContents.executeJavaScript('window.tokenMonitor.openVerdent()').catch(() => {});
    }
    if (process.argv.includes('--login') && window.webContents.getURL().endsWith('/renderer/verdent.html')) {
      window.webContents.executeJavaScript(`(async () => {
        let state = await window.verdent.command('get');
        if (!state.profiles?.length) await window.verdent.command('addProfile', '本机 Verdent');
        await window.verdent.command('configure', { enabled: true });
        await window.verdent.command('login');
      })()`).catch(() => {});
    }
  });
});
require('../src/electron/main');
