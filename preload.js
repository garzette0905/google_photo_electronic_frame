const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getBranding: () => ipcRenderer.invoke('app:branding'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveCredentials: (clientId, clientSecret) =>
    ipcRenderer.invoke('config:saveCredentials', { clientId, clientSecret }),
  setInterval: (sec) => ipcRenderer.invoke('config:setInterval', sec),
  resetAuth: () => ipcRenderer.invoke('app:reset'),

  startBrowserLogin: () => ipcRenderer.invoke('auth:startBrowserLogin'),

  startPickerSession: () => ipcRenderer.invoke('picker:startSession'),
  onMediaReady: (cb) => ipcRenderer.on('picker:mediaReady', (e, p) => cb(p)),
  onPickerError: (cb) => ipcRenderer.on('picker:error', (e, p) => cb(p)),

  syncPhotos: () => ipcRenderer.invoke('photos:sync'),
  getCachedPhotos: () => ipcRenderer.invoke('photos:getCached'),
  onPhotosProgress: (cb) => ipcRenderer.on('photos:progress', (e, p) => cb(p)),

  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  setFullscreen: (on) => ipcRenderer.invoke('window:setFullscreen', on),
  copyPhoto: (fileUrl) => ipcRenderer.invoke('photos:copyToClipboard', fileUrl),
});
