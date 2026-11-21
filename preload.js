const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('winApi', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  dragStart: () => ipcRenderer.send('win-drag-start'),
  dragEnd: () => ipcRenderer.send('win-drag-end')
});

contextBridge.exposeInMainWorld('discordApi', {
  status: (purpose) => ipcRenderer.invoke('discord-status', purpose),
  login: (theme) => ipcRenderer.invoke('discord-login', theme),
  cancelLogin: () => ipcRenderer.send('discord-login-cancel'),
  logout: () => ipcRenderer.invoke('discord-logout'),
  join: () => ipcRenderer.send('discord-join'),
  stats: () => ipcRenderer.invoke('discord-stats'),
  onChanged: (cb) => {
    ipcRenderer.removeAllListeners('discord-changed');
    ipcRenderer.on('discord-changed', () => cb());
  },
  onRoleLost: (cb) => {
    ipcRenderer.removeAllListeners('role-lost');
    ipcRenderer.on('role-lost', (_e, d) => cb(d));
  },
  onBetaGranted: (cb) => {
    ipcRenderer.removeAllListeners('beta-granted');
    ipcRenderer.on('beta-granted', () => cb());
  }
});

contextBridge.exposeInMainWorld('downloadApi', {
  info: () => ipcRenderer.invoke('download-info'),
  meta: () => ipcRenderer.invoke('pack-meta'),
  updateNotice: () => ipcRenderer.invoke('pack-update-notice'),
  refresh: () => ipcRenderer.invoke('pack-refresh'),
  changelog: () => ipcRenderer.invoke('changelog'),
  start: () => ipcRenderer.invoke('download-start'),
  cancel: () => ipcRenderer.send('download-cancel'),
  setAutoUpdate: (on) => ipcRenderer.send('set-auto-update', !!on),
  onMetaChanged: (cb) => {
    ipcRenderer.removeAllListeners('pack-meta-changed');
    ipcRenderer.on('pack-meta-changed', () => cb());
  },
  onProgress: (cb) => {
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.on('download-progress', (_e, d) => cb(d));
  }
});

contextBridge.exposeInMainWorld('uiApi', {
  setZoom: (factor) => webFrame.setZoomFactor(factor)
});

contextBridge.exposeInMainWorld('appApi', {
  restart: () => ipcRenderer.send('app-restart')
});

contextBridge.exposeInMainWorld('installApi', {
  paths: () => ipcRenderer.invoke('install-paths'),
  pick: (kind) => ipcRenderer.invoke('install-pick', kind),
  autodetect: () => ipcRenderer.invoke('install-autodetect'),
  reset: () => ipcRenderer.invoke('install-reset'),
  start: () => ipcRenderer.invoke('install-start'),
  status: () => ipcRenderer.invoke('install-status'),
  uninstall: () => ipcRenderer.invoke('install-uninstall'),
  onModsChanged: (cb) => {
    ipcRenderer.removeAllListeners('mods-changed');
    ipcRenderer.on('mods-changed', () => cb());
  },
  pwCopy: () => ipcRenderer.invoke('pw-copy'),
  pwCheck: (tok) => ipcRenderer.invoke('pw-check', tok),
  modsList: () => ipcRenderer.invoke('mods-list'),
  modsDelete: (name) => ipcRenderer.invoke('mods-delete', name),
  modsDeleteRms: (name) => ipcRenderer.invoke('mods-delete-rms', name),
  modsInstallRms: (name) => ipcRenderer.invoke('mods-install-rms', name),
  enbStatus: () => ipcRenderer.invoke('enb-status'),
  enbInstall: () => ipcRenderer.invoke('enb-install'),
  enbUninstall: () => ipcRenderer.invoke('enb-uninstall'),
  cancel: () => ipcRenderer.send('install-cancel'),
  onProgress: (cb) => {
    ipcRenderer.removeAllListeners('install-progress');
    ipcRenderer.on('install-progress', (_e, d) => cb(d));
  },
  onEnbProgress: (cb) => {
    ipcRenderer.removeAllListeners('enb-progress');
    ipcRenderer.on('enb-progress', (_e, d) => cb(d));
  }
});

contextBridge.exposeInMainWorld('sysApi', {
  info: () => ipcRenderer.invoke('sys-info')
});

contextBridge.exposeInMainWorld('cacheApi', {
  scan: () => ipcRenderer.invoke('cache-scan'),
  clean: (ids) => ipcRenderer.invoke('cache-clean', ids)
});

contextBridge.exposeInMainWorld('optApi', {
  meta: () => ipcRenderer.invoke('opt-meta'),
  install: (id, opts) => ipcRenderer.invoke('opt-install', id, opts),
  uninstall: (id) => ipcRenderer.invoke('opt-uninstall', id),
  cancel: () => ipcRenderer.send('install-cancel'),
  onProgress: (cb) => {
    ipcRenderer.removeAllListeners('opt-progress');
    ipcRenderer.on('opt-progress', (_e, d) => cb(d));
  }
});

contextBridge.exposeInMainWorld('bgApi', {
  info: () => ipcRenderer.invoke('bg-info'),
  pick: () => ipcRenderer.invoke('bg-pick'),
  bytes: (req) => ipcRenderer.invoke('bg-bytes', req),
  clear: () => ipcRenderer.invoke('bg-clear')
});

contextBridge.exposeInMainWorld('perfApi', {
  scan: () => ipcRenderer.invoke('perf-scan'),
  clean: (ids) => ipcRenderer.invoke('perf-clean', ids)
});

contextBridge.exposeInMainWorld('fixApi', {
  afStatus: () => ipcRenderer.invoke('fix-af-status'),
  afApply: () => ipcRenderer.invoke('fix-af-apply'),
  afUndo: () => ipcRenderer.invoke('fix-af-undo')
});

contextBridge.exposeInMainWorld('presenceApi', {
  setTab: (tab) => ipcRenderer.send('presence-tab', String(tab))
});

contextBridge.exposeInMainWorld('launcherUpdateApi', {
  state: () => ipcRenderer.invoke('launcher-update-state'),
  download: () => ipcRenderer.send('launcher-update-download'),
  version: () => ipcRenderer.invoke('app-version'),
  now: () => ipcRenderer.send('launcher-update-now'),
  later: () => ipcRenderer.send('launcher-update-later'),
  retry: () => ipcRenderer.send('launcher-update-retry'),
  onState: (cb) => {
    ipcRenderer.removeAllListeners('launcher-update');
    ipcRenderer.on('launcher-update', (_e, s) => cb(s));
  }
});