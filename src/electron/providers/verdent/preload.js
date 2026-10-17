'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const commands = new Set(['get', 'configure', 'selectHistory', 'addProfile', 'login', 'completeLogin', 'clearSession', 'refresh', 'refreshFull', 'validateWeek', 'cancel']);
contextBridge.exposeInMainWorld('verdent', {
  command: (command, input) => commands.has(command) ? ipcRenderer.invoke('verdent:command', command, input) : Promise.reject(new Error('Unknown command')),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('verdent:state', listener);
    return () => ipcRenderer.removeListener('verdent:state', listener);
  }
});
