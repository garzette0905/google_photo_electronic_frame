const screens = {
  credentials: document.getElementById('screen-credentials'),
  auth: document.getElementById('screen-auth'),
  source: document.getElementById('screen-source'),
  sync: document.getElementById('screen-sync'),
};
const onboardingShell = document.getElementById('onboarding-shell');
const slideshowEl = document.getElementById('screen-slideshow');

function showOnboarding(name) {
  slideshowEl.classList.add('hidden');
  onboardingShell.classList.remove('hidden');
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}

function showSlideshow() {
  onboardingShell.classList.add('hidden');
  slideshowEl.classList.remove('hidden');
}

// ---------------- Branding ----------------

async function loadBranding() {
  const b = await window.api.getBranding();
  document.body.style.backgroundImage =
    `linear-gradient(rgba(11,18,32,0.72), rgba(11,18,32,0.88)), url("${b.imageUrl}")`;
  document.getElementById('brand-title').textContent = b.title;
  document.getElementById('brand-name').textContent = b.appName;
  return b;
}

// ---------------- Screen 1: credentials ----------------

document.getElementById('btn-save-credentials').addEventListener('click', async () => {
  const clientId = document.getElementById('input-client-id').value.trim();
  const clientSecret = document.getElementById('input-client-secret').value.trim();
  const errEl = document.getElementById('credentials-error');
  errEl.classList.add('hidden');
  if (!clientId || !clientSecret) {
    errEl.textContent = 'Client ID와 Client Secret을 모두 입력해주세요.';
    errEl.classList.remove('hidden');
    return;
  }
  await window.api.saveCredentials(clientId, clientSecret);
  startAuthFlow();
});

document.getElementById('btn-open-console').addEventListener('click', () => {
  window.api.openExternal('https://console.cloud.google.com/apis/credentials');
});

// ---------------- Screen 2: browser login ----------------

function startAuthFlow() {
  showOnboarding('auth');
  document.getElementById('auth-error').classList.add('hidden');
  document.getElementById('auth-status').classList.add('hidden');
  document.getElementById('btn-start-login').classList.remove('hidden');
}

document.getElementById('btn-start-login').addEventListener('click', async () => {
  const btn = document.getElementById('btn-start-login');
  const statusEl = document.getElementById('auth-status');
  const errEl = document.getElementById('auth-error');
  errEl.classList.add('hidden');
  btn.classList.add('hidden');
  statusEl.classList.remove('hidden');

  try {
    await window.api.startBrowserLogin();
    statusEl.textContent = '로그인 완료! 사진을 선택하는 화면으로 이동합니다...';
    startPickerFlow();
  } catch (err) {
    statusEl.classList.add('hidden');
    btn.classList.remove('hidden');
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

// ---------------- Screen 3: picker (photo selection) ----------------

async function startPickerFlow() {
  showOnboarding('source');
  const qrEl = document.getElementById('source-qr');
  const statusEl = document.getElementById('source-status');
  const errEl = document.getElementById('source-error');
  const retryEl = document.getElementById('btn-source-retry');
  const openBtn = document.getElementById('btn-source-open');
  qrEl.classList.add('hidden');
  errEl.classList.add('hidden');
  retryEl.classList.add('hidden');
  openBtn.classList.add('hidden');
  statusEl.textContent = '선택 화면을 준비하는 중...';

  try {
    const result = await window.api.startPickerSession();
    qrEl.src = result.qrDataUrl;
    qrEl.classList.remove('hidden');
    openBtn.classList.remove('hidden');
    openBtn.onclick = (e) => {
      e.preventDefault();
      window.api.openExternal(result.pickerUri);
    };
    statusEl.textContent = '선택 화면에서 사진을 고르는 중...';
  } catch (err) {
    statusEl.textContent = '';
    errEl.textContent = err.message.includes('SCOPE')
      ? '권한(스코프)이 부족합니다. Google Cloud Console에서 스코프를 추가한 뒤, 아래 버튼으로 다시 연결해주세요.'
      : err.message;
    errEl.classList.remove('hidden');
    retryEl.classList.remove('hidden');
  }
}

document.getElementById('btn-source-retry').addEventListener('click', async () => {
  await window.api.resetAuth();
  startAuthFlow();
});

window.api.onMediaReady(() => {
  document.getElementById('source-status').textContent = '선택 완료! 사진을 불러옵니다...';
  startSync();
});
window.api.onPickerError((p) => {
  document.getElementById('source-error').textContent = p.message;
  document.getElementById('source-error').classList.remove('hidden');
});

// ---------------- Screen 4: syncing ----------------

async function startSync() {
  showOnboarding('sync');
  const statusEl = document.getElementById('sync-status');
  const barEl = document.getElementById('sync-bar');
  statusEl.textContent = '사진 목록을 불러오는 중...';
  barEl.style.width = '5%';

  window.api.onPhotosProgress((p) => {
    if (p.phase === 'listing') {
      statusEl.textContent = `사진 목록 확인 중... (${p.count}장)`;
    } else if (p.phase === 'downloading') {
      statusEl.textContent = `사진 내려받는 중... (${p.count}/${p.total})`;
      barEl.style.width = `${Math.round((p.count / p.total) * 100)}%`;
    }
  });

  const photos = await window.api.syncPhotos();
  boot(photos);
}

// ---------------- Screen 5: slideshow ----------------

let allPhotos = [];
let filteredPhotos = [];
let currentIndex = 0;
let intervalHandle = null;
let activeLayer = 'a';

function formatDate(iso) {
  const d = new Date(iso);
  const main = new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric',
  }).format(d);
  const weekday = new Intl.DateTimeFormat('ko-KR', { weekday: 'long' }).format(d);
  const time = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(d);
  return { main, sub: `${weekday} · ${time}` };
}

function renderPhotoList() {
  const strip = document.getElementById('photo-list-strip');
  strip.innerHTML = '';
  document.getElementById('photo-list-count').textContent = filteredPhotos.length;

  if (filteredPhotos.length === 0) {
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = '표시할 사진이 없습니다.';
    strip.appendChild(span);
    return;
  }

  filteredPhotos.forEach((p) => {
    const img = document.createElement('img');
    img.src = p.thumbUrl;
    img.title = formatDate(p.createTime).main;
    img.addEventListener('click', () => jumpTo(p.id));
    strip.appendChild(img);
  });
  updateActiveThumb();
}

function updateActiveThumb() {
  const strip = document.getElementById('photo-list-strip');
  [...strip.children].forEach((el, idx) => {
    el.classList?.toggle('current', idx === currentIndex);
  });
  const currentEl = strip.children[currentIndex];
  currentEl?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function jumpTo(id) {
  const idx = filteredPhotos.findIndex((p) => p.id === id);
  if (idx === -1) return;
  currentIndex = idx;
  showCurrent();
  resetTimer();
}

function preload(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = resolve;
    img.onerror = resolve; // don't let a broken file freeze the slideshow
    img.src = url;
  });
}

async function showCurrent() {
  if (filteredPhotos.length === 0) return;
  const photo = filteredPhotos[currentIndex];
  const requestedIndex = currentIndex;
  const nextLayerId = activeLayer === 'a' ? 'photo-b' : 'photo-a';
  const prevLayerId = activeLayer === 'a' ? 'photo-a' : 'photo-b';
  const nextLayer = document.getElementById(nextLayerId);
  const prevLayer = document.getElementById(prevLayerId);

  // A persistent <img>'s onload only fires when its src actually changes, but with a
  // small photo set the same fullUrl can recur — so preload with a throwaway Image
  // (always fires) and toggle the visible layers ourselves instead of trusting onload.
  await preload(photo.fullUrl);
  if (requestedIndex !== currentIndex) return; // superseded by a jump/advance meanwhile

  nextLayer.src = photo.fullUrl;
  nextLayer.classList.add('active');
  prevLayer.classList.remove('active');
  activeLayer = activeLayer === 'a' ? 'b' : 'a';

  const { main, sub } = formatDate(photo.createTime);
  document.getElementById('cur-date-main').textContent = main;
  document.getElementById('cur-date-sub').textContent = sub;
  updateActiveThumb();
}

function advance() {
  if (filteredPhotos.length === 0) return;
  currentIndex = (currentIndex + 1) % filteredPhotos.length;
  showCurrent();
}

function resetTimer(intervalSec) {
  if (intervalHandle) clearInterval(intervalHandle);
  const sec = intervalSec || window.__intervalSec || 10;
  intervalHandle = setInterval(advance, sec * 1000);
}

function periodCutoff(range) {
  const cutoff = new Date();
  if (range === 'week') cutoff.setDate(cutoff.getDate() - 7);
  else if (range === 'month') cutoff.setMonth(cutoff.getMonth() - 1);
  else if (range === 'year') cutoff.setFullYear(cutoff.getFullYear() - 1);
  else return null; // 'all'
  return cutoff;
}

function refreshSlideshow() {
  if (filteredPhotos.length === 0) filteredPhotos = allPhotos;
  currentIndex = 0;
  renderPhotoList();
  showCurrent();
  resetTimer();
}

function applyPeriod(range) {
  const cutoff = periodCutoff(range);
  filteredPhotos = cutoff ? allPhotos.filter((p) => new Date(p.createTime) >= cutoff) : allPhotos;

  document.getElementById('filter-start').value = '';
  document.getElementById('filter-end').value = '';
  document.querySelectorAll('#period-presets .preset').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === range);
  });
  refreshSlideshow();
}

function applyCustomRange() {
  const start = document.getElementById('filter-start').value; // YYYY-MM-DD
  const end = document.getElementById('filter-end').value;
  if (!start && !end) {
    applyPeriod('all');
    return;
  }
  filteredPhotos = allPhotos.filter((p) => {
    const d = p.createTime.slice(0, 10);
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });
  document.querySelectorAll('#period-presets .preset').forEach((btn) => btn.classList.remove('active'));
  refreshSlideshow();
}

document.querySelectorAll('#period-presets .preset').forEach((btn) => {
  btn.addEventListener('click', () => applyPeriod(btn.dataset.range));
});
document.getElementById('btn-range-apply').addEventListener('click', applyCustomRange);

document.getElementById('btn-reselect').addEventListener('click', (e) => {
  e.preventDefault();
  if (intervalHandle) clearInterval(intervalHandle);
  startPickerFlow();
});
document.getElementById('btn-reset').addEventListener('click', async (e) => {
  e.preventDefault();
  await window.api.resetAuth();
  location.reload();
});

// ---------------- Fullscreen & share ----------------

async function setFullscreen(on) {
  document.body.classList.toggle('fullscreen', on);
  await window.api.setFullscreen(on);
}

document.getElementById('btn-fullscreen').addEventListener('click', () => {
  setFullscreen(!document.body.classList.contains('fullscreen'));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('fullscreen')) {
    setFullscreen(false);
  }
});

let toastHandle = null;
function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.add('hidden'), 2500);
}

document.getElementById('btn-share').addEventListener('click', async () => {
  const photo = filteredPhotos[currentIndex];
  if (!photo) return;
  try {
    await window.api.copyPhoto(photo.fullUrl);
    showToast('사진이 클립보드에 복사되었습니다. 메신저에 붙여넣기(Ctrl+V) 하세요.');
  } catch (err) {
    showToast('복사 실패: ' + err.message);
  }
});

async function boot(photos) {
  allPhotos = photos;
  currentIndex = 0;

  const cfg = await window.api.getConfig();
  window.__intervalSec = cfg.photoIntervalSec || 10;

  showSlideshow();
  applyPeriod('all');
}

// ---------------- App init ----------------

async function init() {
  await loadBranding();
  const cfg = await window.api.getConfig();

  if (!cfg.clientId || !cfg.hasClientSecret) {
    showOnboarding('credentials');
    return;
  }
  if (!cfg.hasRefreshToken) {
    startAuthFlow();
    return;
  }

  const cached = await window.api.getCachedPhotos();
  if (cached && cached.length > 0) {
    boot(cached);
  } else {
    startPickerFlow();
  }
}

init();
