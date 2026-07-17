const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage } = require('electron');
const path = require('path');
const QRCode = require('qrcode');

const config = require('./src/config');
const auth = require('./src/auth');
const picker = require('./src/pickerApi');
const cache = require('./src/cache');

const BRANDING_IMAGE = path.join(
  __dirname,
  'Gemini_Generated_Image_ot3sxkot3sxkot3s.png'
);
const APP_TITLE = '그날의 우리를 마주하다';
const APP_NAME = '기억 조각 이어주기';

let mainWindow;
/** @type {{accessToken: string|null, expiresAt: number, requestId: string|null, pickerSessionId: string|null}} */
const session = { accessToken: null, expiresAt: 0, requestId: null, pickerSessionId: null };

function send(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}

async function ensureAccessToken() {
  const cfg = config.load();
  if (session.accessToken && Date.now() < session.expiresAt - 60_000) {
    return session.accessToken;
  }
  if (!cfg.refreshToken) throw new Error('NEEDS_AUTH');
  const data = await auth.refreshAccessToken(cfg.clientId, cfg.clientSecret, cfg.refreshToken);
  session.accessToken = data.access_token;
  session.expiresAt = Date.now() + data.expires_in * 1000;
  return session.accessToken;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: APP_NAME,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------

ipcMain.handle('app:branding', () => ({
  appName: APP_NAME,
  title: APP_TITLE,
  imageUrl: 'file://' + BRANDING_IMAGE.replace(/\\/g, '/'),
}));

ipcMain.handle('config:get', () => {
  const cfg = config.load();
  return {
    clientId: cfg.clientId,
    hasClientSecret: !!cfg.clientSecret,
    hasRefreshToken: !!cfg.refreshToken,
    photoIntervalSec: cfg.photoIntervalSec,
  };
});

ipcMain.handle('config:saveCredentials', (e, { clientId, clientSecret }) => {
  config.save({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
  return true;
});

ipcMain.handle('config:setInterval', (e, sec) => {
  config.save({ photoIntervalSec: Math.max(3, Number(sec) || 10) });
  return true;
});

ipcMain.handle('app:reset', () => {
  config.save({ refreshToken: '' });
  session.accessToken = null;
  session.expiresAt = 0;
  session.pickerSessionId = null;
  return true;
});

// Step 1: log in via the system browser (Picker API's scope isn't allowed on the
// TV/limited-input device flow, so this uses the standard installed-app + PKCE flow).
ipcMain.handle('auth:startBrowserLogin', async () => {
  const cfg = config.load();
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('Client ID/Secret이 설정되지 않았습니다.');

  try {
    const tokenData = await auth.loginWithBrowser({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      openUrl: (url) => shell.openExternal(url),
    });
    session.accessToken = tokenData.access_token;
    session.expiresAt = Date.now() + tokenData.expires_in * 1000;
    if (tokenData.refresh_token) config.save({ refreshToken: tokenData.refresh_token });
    return true;
  } catch (err) {
    throw new Error(err.message);
  }
});

// Step 2: create a Picker session & wait for the user to select photos.
// Also used later for the "다시 선택하기" (re-pick) button — Picker sessions are
// one-shot, so refreshing the photo set means creating a brand new session.
ipcMain.handle('picker:startSession', async () => {
  const accessToken = await ensureAccessToken();
  const requestId = session.requestId || auth.newRequestId();

  const picking = await picker.createSession(accessToken, requestId);
  session.pickerSessionId = picking.id;

  const qrDataUrl = await QRCode.toDataURL(picking.pickerUri);

  (async () => {
    try {
      await picker.pollUntilMediaItemsSet(accessToken, picking.id, {
        onTick: () => send('picker:tick', {}),
      });
      send('picker:mediaReady', {});
    } catch (err) {
      send('picker:error', { message: err.message });
    }
  })();

  return { pickerUri: picking.pickerUri, qrDataUrl };
});

// Step 3: pull down the actual photos + cache them locally
ipcMain.handle('photos:sync', async () => {
  const accessToken = await ensureAccessToken();
  if (!session.pickerSessionId) throw new Error('사진이 아직 선택되지 않았습니다.');

  const items = await picker.listAllMediaItems(accessToken, session.pickerSessionId, {
    onPage: (count) => send('photos:progress', { phase: 'listing', count }),
  });

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const [full, thumb] = await Promise.all([
        cache.downloadFull(accessToken, item),
        cache.downloadThumb(accessToken, item),
      ]);
      results.push({
        id: item.id,
        createTime: item.createTime,
        fullUrl: 'file://' + full.replace(/\\/g, '/'),
        thumbUrl: 'file://' + thumb.replace(/\\/g, '/'),
      });
    } catch (err) {
      // Skip items that fail to download rather than aborting the whole sync.
    }
    send('photos:progress', { phase: 'downloading', count: i + 1, total: items.length });
  }

  // 재선택 = 대체: 새로 고른 사진들로 목록을 완전히 교체한다.
  results.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
  cache.savePhotoList(results);

  await picker.deleteSession(accessToken, session.pickerSessionId).catch(() => {});
  session.pickerSessionId = null;

  return results;
});

ipcMain.handle('photos:getCached', () => cache.loadPhotoList());

ipcMain.handle('shell:openExternal', (e, url) => shell.openExternal(url));

// Fullscreen photo mode: also hide the app menu bar so nothing covers the photo.
ipcMain.handle('window:setFullscreen', (e, on) => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!!on);
  mainWindow.setMenuBarVisibility(!on);
  return true;
});

// "공유하기": copy the current photo image to the clipboard (Picker API는
// 공유용 구글 링크를 제공하지 않아 이미지 자체를 복사하는 방식으로 대체).
ipcMain.handle('photos:copyToClipboard', (e, fileUrl) => {
  const filePath = decodeURI(String(fileUrl).replace(/^file:\/\//, ''));
  const img = nativeImage.createFromPath(filePath);
  if (img.isEmpty()) throw new Error('이미지를 불러오지 못했습니다.');
  clipboard.writeImage(img);
  return true;
});
