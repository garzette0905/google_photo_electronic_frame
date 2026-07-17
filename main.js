const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage, session: electronSession } = require('electron');
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

  // 디버깅용: 렌더러 콘솔 로그를 메인 프로세스 stdout으로도 출력
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });

  // 메인 창이 닫히면 숨김 음악 창도 함께 정리 (남아있으면 앱이 종료되지 않음)
  mainWindow.on('closed', () => {
    if (musicWindow && !musicWindow.isDestroyed()) musicWindow.destroy();
  });
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
    bgMusicUrl: cfg.bgMusicUrl,
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

ipcMain.handle('config:setBgMusicUrl', (e, url) => {
  config.save({ bgMusicUrl: String(url || '').trim() });
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

// ---------- 배경음악: 숨김 창에서 유튜브 시청 페이지를 직접 재생 ----------
// 임베드(iframe/embed URL) 방식은 유튜브의 Referer 정책으로 전부 차단된다(에러 152/153).
// 일반 watch 페이지를 보이지 않는 창에서 여는 것은 일반 브라우저 시청과 동일해서
// 항상 재생된다. 제어(재생/정지/볼륨/반복)는 그 창의 <video> 요소를 직접 조작한다.

let musicWindow = null;

function musicJs(code) {
  if (!musicWindow || musicWindow.isDestroyed()) return Promise.resolve(null);
  return musicWindow.webContents.executeJavaScript(code).catch(() => null);
}

ipcMain.handle('music:load', async (e, { url, videoId }) => {
  if (!musicWindow || musicWindow.isDestroyed()) {
    musicWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // 숨김 창은 타이머가 강하게 스로틀링되어 광고 건너뛰기 감시가 멈추므로 해제
        backgroundThrottling: false,
      },
    });
    musicWindow.setMenuBarVisibility(false);
    musicWindow.webContents.on('console-message', (ev, level, message) => {
      if (message.includes('[skip-ad]')) console.log('[music-win]', message);
    });
  }

  await musicWindow.loadURL(`https://www.youtube.com/watch?v=${videoId}`);
  config.save({ bgMusicUrl: url });

  // 재생 보장 + 반복 재생 설정 + 광고 "건너뛰기" 버튼 자동 클릭.
  // 광고를 차단하는 것이 아니라, 유튜브가 건너뛰기를 허용하는 시점(버튼 등장)에
  // 사용자가 누르는 것과 동일하게 클릭만 대신해준다.
  // 타이머(setInterval)와 DOM 변화 감지(MutationObserver)를 병행해 놓치지 않게 한다.
  await musicJs(`(function(){
    const v = document.querySelector('video');
    if (v) { v.loop = true; v.play(); }

    if (window.__skipAdInstalled) return;
    window.__skipAdInstalled = true;

    function clickSkip() {
      const selectors = [
        '.ytp-skip-ad-button',
        '.ytp-ad-skip-button',
        '.ytp-ad-skip-button-modern',
        '.ytp-ad-skip-button-slot button',
        'button[class*="skip"]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          console.log('[skip-ad] clicked:', sel);
          return true;
        }
      }
      return false;
    }

    setInterval(clickSkip, 800);
    new MutationObserver(clickSkip).observe(document.body, { childList: true, subtree: true });
  })()`);

  const title = await musicJs('document.title');
  return { title: (title || '').replace(/ - YouTube$/, '') };
});

ipcMain.handle('music:toggle', async () => {
  const playing = await musicJs(`(function(){
    const v = document.querySelector('video');
    if (!v) return false;
    if (v.paused) { v.play(); return true; }
    v.pause(); return false;
  })()`);
  return { playing: !!playing };
});

ipcMain.handle('music:volume', async (e, vol) => {
  await musicJs(`(function(){
    const v = document.querySelector('video');
    if (v) v.volume = ${Math.min(100, Math.max(0, Number(vol))) / 100};
  })()`);
  return true;
});

app.on('before-quit', () => {
  if (musicWindow && !musicWindow.isDestroyed()) musicWindow.destroy();
});

// '창 닫기': 저장된 사진 캐시를 모두 지우고 앱 종료.
// 다음 실행 때는 캐시가 없으므로 사진 선택 화면부터 새로 시작된다. (로그인은 유지)
ipcMain.handle('app:closeAndClear', () => {
  cache.clearAll();
  app.quit();
});
