// ---------- 화면 전환 ----------
const screens = {
  login: document.getElementById('screen-login'),
  source: document.getElementById('screen-source'),
  sync: document.getElementById('screen-sync'),
};
const onboardingShell = document.getElementById('onboarding-shell');
const slideshowEl = document.getElementById('screen-slideshow');

function showOnboarding(name) {
  slideshowEl.classList.add('hidden');
  onboardingShell.classList.remove('hidden');
  Object.entries(screens).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
}
function showSlideshow() {
  onboardingShell.classList.add('hidden');
  slideshowEl.classList.remove('hidden');
}

// 밝은 스플래시를 holdMs 동안 보여준 뒤 페이드 아웃
function withSplash(reveal, holdMs = 3000) {
  const splash = document.getElementById('splash');
  splash.style.transition = 'none';
  splash.classList.remove('fade-out');
  void splash.offsetHeight;
  splash.style.transition = '';
  reveal();
  setTimeout(() => splash.classList.add('fade-out'), holdMs);
}

async function api(url, opts) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (res.status === 401) { showOnboarding('login'); throw new Error('로그인이 필요합니다.'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `요청 실패 (${res.status})`);
  return res.json();
}

// ---------- 로그인 화면 ----------
const AUTH_ERROR_MESSAGES = {
  missing_photos_scope:
    '로그인 중 "Google 포토" 권한에 동의하지 않아 사진을 가져올 수 없습니다. ' +
    '아래 버튼으로 다시 로그인하시고, 동의 화면에서 사진 관련 권한 체크박스를 꼭 체크해주세요.',
};

function showLogin() {
  showOnboarding('login');
  const params = new URLSearchParams(location.search);
  const code = params.get('auth_error');
  if (code) {
    const el = document.getElementById('login-error');
    el.textContent = AUTH_ERROR_MESSAGES[code] || '로그인 오류: ' + code;
    el.classList.remove('hidden');
  }
}

// ---------- 사진 선택 (Picker) ----------
let pickerSessionId = null;
let pickerPollTimer = null;

async function startPickerFlow() {
  showOnboarding('source');
  const qrEl = document.getElementById('source-qr');
  const statusEl = document.getElementById('source-status-text');
  const backEl = document.getElementById('btn-back-to-slideshow');
  const errEl = document.getElementById('source-error');
  const openBtn = document.getElementById('btn-open-picker');
  const noticeEl = document.getElementById('account-notice');
  qrEl.classList.add('hidden');
  errEl.classList.add('hidden');
  statusEl.textContent = '선택 화면을 준비하는 중...';
  // 이미 보고 있던 사진이 있을 때만 "돌아가기"를 보여준다 (최초 선택 시에는 돌아갈 곳이 없음)
  backEl.classList.toggle('hidden', allPhotos.length === 0);

  if (loggedInName) {
    noticeEl.textContent = `사진은 ${loggedInName} 계정으로만 가능합니다.`;
    noticeEl.classList.remove('hidden');
  } else {
    noticeEl.classList.add('hidden');
  }

  try {
    const s = await api('/api/picker/session', { method: 'POST' });
    pickerSessionId = s.id;
    qrEl.src = s.qrDataUrl;
    qrEl.classList.remove('hidden');
    openBtn.onclick = () => window.open(s.pickerUri, '_blank');
    statusEl.textContent = '사진을 선택하면 자동으로 이어집니다...';
    pollPicker();
  } catch (err) {
    statusEl.textContent = '';
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

document.getElementById('btn-back-to-slideshow').addEventListener('click', (e) => {
  e.preventDefault();
  if (pickerPollTimer) clearTimeout(pickerPollTimer);
  if (pickerSessionId) api(`/api/picker/session/${pickerSessionId}`, { method: 'DELETE' }).catch(() => {});
  showSlideshow();
  resetTimer();
});

function pollPicker() {
  if (pickerPollTimer) clearTimeout(pickerPollTimer);
  const tick = async () => {
    try {
      const s = await api(`/api/picker/session/${pickerSessionId}`);
      if (s.mediaItemsSet) { startSync(); return; }
    } catch { /* 네트워크 순단 무시 */ }
    pickerPollTimer = setTimeout(tick, 3000);
  };
  pickerPollTimer = setTimeout(tick, 3000);
}

// ---------- 동기화 ----------
async function startSync() {
  if (pickerPollTimer) clearTimeout(pickerPollTimer);
  showOnboarding('sync');
  const statusEl = document.getElementById('sync-status');
  const barEl = document.getElementById('sync-bar');
  statusEl.textContent = '선택한 사진을 불러오는 중...';
  barEl.style.width = '30%';

  try {
    const { items } = await api(`/api/picker/media?sessionId=${encodeURIComponent(pickerSessionId)}`);
    barEl.style.width = '100%';
    api(`/api/picker/session/${pickerSessionId}`, { method: 'DELETE' }).catch(() => {});
    if (!items.length) {
      statusEl.textContent = '선택된 사진이 없습니다. 다시 선택해주세요.';
      setTimeout(startPickerFlow, 1500);
      return;
    }
    boot(items);
  } catch (err) {
    statusEl.textContent = '불러오기 실패: ' + err.message;
  }
}

// ---------- 슬라이드쇼 ----------
let allPhotos = [];
let filteredPhotos = [];
let currentIndex = 0;
let intervalHandle = null;
let activeLayer = 'a';
let slideshowPaused = false;

function formatDate(iso) {
  const d = new Date(iso);
  const main = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  const weekday = new Intl.DateTimeFormat('ko-KR', { weekday: 'long' }).format(d);
  const time = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(d);
  return { main, sub: `${weekday} · ${time}` };
}

function renderPhotoList() {
  const strip = document.getElementById('photo-list-strip');
  strip.innerHTML = '';
  document.getElementById('photo-list-count').textContent = filteredPhotos.length;
  if (!filteredPhotos.length) {
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
  [...strip.children].forEach((el, idx) => el.classList?.toggle('current', idx === currentIndex));
  strip.children[currentIndex]?.scrollIntoView?.({ block: 'nearest' });
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
    img.onerror = resolve;
    img.src = url;
  });
}

async function showCurrent() {
  if (!filteredPhotos.length) return;
  const photo = filteredPhotos[currentIndex];
  const requested = currentIndex;
  const nextLayer = document.getElementById(activeLayer === 'a' ? 'photo-b' : 'photo-a');
  const prevLayer = document.getElementById(activeLayer === 'a' ? 'photo-a' : 'photo-b');
  await preload(photo.fullUrl);
  if (requested !== currentIndex) return;
  nextLayer.src = photo.fullUrl;
  nextLayer.classList.add('active');
  prevLayer.classList.remove('active');
  activeLayer = activeLayer === 'a' ? 'b' : 'a';

  const { main, sub } = formatDate(photo.createTime);
  document.getElementById('cur-date-main').textContent = main;
  document.getElementById('cur-date-sub').textContent = sub;
  updateFullscreenCaption(photo);
  updateActiveThumb();
}

function updateFullscreenCaption(photo) {
  const el = document.getElementById('fullscreen-caption');
  const d = new Date(photo.createTime);
  const dateStr = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const timeStr = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(d);
  const lines = [`${dateStr} ${timeStr}`];
  if (photo.place) lines.push(photo.place);
  if (musicPlaying && musicTitle) lines.push(`♪ ${musicTitle}`);
  el.textContent = '';
  lines.forEach((line, i) => {
    if (i > 0) el.appendChild(document.createElement('br'));
    el.appendChild(document.createTextNode(line));
  });
}
function refreshCaption() {
  const photo = filteredPhotos[currentIndex];
  if (photo) updateFullscreenCaption(photo);
}

function advance() {
  if (!filteredPhotos.length) return;
  currentIndex = (currentIndex + 1) % filteredPhotos.length;
  showCurrent();
}
function resetTimer() {
  if (intervalHandle) clearInterval(intervalHandle);
  if (slideshowPaused) return;
  intervalHandle = setInterval(advance, 10000);
}

function setSlideshowPaused(paused) {
  slideshowPaused = paused;
  const btn = document.getElementById('btn-pause');
  btn.textContent = paused ? '▶ 화면 재개' : '⏸ 화면 잠시멈춤';
  if (paused) { if (intervalHandle) clearInterval(intervalHandle); intervalHandle = null; }
  else resetTimer();
}
document.getElementById('btn-pause').addEventListener('click', () => setSlideshowPaused(!slideshowPaused));

// ---------- 기간 + 방향 필터 ----------
let periodFilterFn = () => true; // 현재 기간 조건
let orientationMode = 'all'; // 'all' | 'landscape' | 'portrait'

function periodCutoff(range) {
  const c = new Date();
  if (range === 'week') c.setDate(c.getDate() - 7);
  else if (range === 'month') c.setMonth(c.getMonth() - 1);
  else if (range === 'year') c.setFullYear(c.getFullYear() - 1);
  else return null;
  return c;
}

function orientationOf(p) {
  if (!p.width || !p.height) return null; // 크기 정보 없으면 방향 미상
  return p.width >= p.height ? 'landscape' : 'portrait';
}

// 기간·방향 조건을 함께 적용해 현재 표시할 사진 목록을 다시 계산한다.
function recomputeFiltered() {
  let list = allPhotos.filter(periodFilterFn);
  if (!list.length) {
    showToast('해당 기간 내 사진이 없습니다.');
    list = allPhotos; // 기간 조건 무시하고 전체로 복귀
  }
  if (orientationMode !== 'all') {
    const byOrient = list.filter((p) => orientationOf(p) === orientationMode);
    if (!byOrient.length) {
      showToast(orientationMode === 'landscape' ? '가로 사진이 없습니다.' : '세로 사진이 없습니다.');
      orientationMode = 'all';
      const allRadio = document.querySelector('#orientation-radios input[value="all"]');
      if (allRadio) allRadio.checked = true;
    } else {
      list = byOrient;
    }
  }
  filteredPhotos = list;
  currentIndex = 0;
  renderPhotoList();
  showCurrent();
  resetTimer();
}

function applyPeriod(range) {
  const cutoff = periodCutoff(range);
  periodFilterFn = cutoff ? (p) => new Date(p.createTime) >= cutoff : () => true;
  document.getElementById('filter-start').value = '';
  document.getElementById('filter-end').value = '';
  document.querySelectorAll('#period-presets .preset').forEach((b) => b.classList.toggle('active', b.dataset.range === range));
  recomputeFiltered();
}
function applyCustomRange() {
  const start = document.getElementById('filter-start').value;
  const end = document.getElementById('filter-end').value;
  if (!start && !end) { applyPeriod('all'); return; }
  periodFilterFn = (p) => {
    const d = p.createTime.slice(0, 10);
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  };
  document.querySelectorAll('#period-presets .preset').forEach((b) => b.classList.remove('active'));
  recomputeFiltered();
}
document.querySelectorAll('#period-presets .preset').forEach((b) => b.addEventListener('click', () => applyPeriod(b.dataset.range)));
document.getElementById('btn-range-apply').addEventListener('click', applyCustomRange);
document.querySelectorAll('#orientation-radios input').forEach((r) =>
  r.addEventListener('change', () => { if (r.checked) { orientationMode = r.value; recomputeFiltered(); } })
);

// ---------- 전체화면 / 공유 ----------
function setFullscreen(on) {
  document.body.classList.toggle('fullscreen', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
document.getElementById('btn-fullscreen').addEventListener('click', () => setFullscreen(!document.body.classList.contains('fullscreen')));
document.addEventListener('fullscreenchange', () => {
  // 사용자가 F11/Esc로 직접 빠져나온 경우 상태 동기화
  document.body.classList.toggle('fullscreen', !!document.fullscreenElement);
});

let toastHandle = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.add('hidden'), 2500);
}

// 브라우저의 비동기 클립보드 API는 이미지 타입으로 image/png만 안정적으로 지원한다
// (구글 포토가 내려주는 image/jpeg를 그대로 쓰면 브라우저가 거부한다).
// 그래서 캔버스로 그린 뒤 PNG로 변환해서 복사한다.
function toPngBlob(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('이미지 변환 실패'))), 'image/png');
    };
    img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
    img.src = url;
  });
}

// 모바일폰(Android/iPhone/iPod)에서는 클립보드 이미지 복사가 사실상 동작하지 않으므로
// 공유(복사) 버튼 자체를 숨긴다. 데스크톱/태블릿에서는 그대로 노출.
const IS_PHONE = /Android|iPhone|iPod/i.test(navigator.userAgent);
if (IS_PHONE) document.getElementById('btn-share').classList.add('hidden');

document.getElementById('btn-share').addEventListener('click', async () => {
  const photo = filteredPhotos[currentIndex];
  if (!photo) return;
  try {
    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error('이 브라우저는 이미지 복사를 지원하지 않습니다.');
    }
    const pngBlob = await toPngBlob(photo.fullUrl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    showToast('사진이 클립보드에 복사되었습니다. 붙여넣기(Ctrl+V) 하세요.');
  } catch (err) {
    showToast('복사 실패: ' + err.message);
  }
});

// ---------- 배경음악 (YouTube IFrame API) ----------
let ytPlayer = null;
let ytReady = null;
let musicLoaded = false;
let musicPlaying = false;
let musicTitle = '';

function loadYouTubeApi() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    window.onYouTubeIframeAPIReady = resolve;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return ytReady;
}

function extractYouTubeId(url) {
  const pats = [/youtu\.be\/([\w-]{11})/, /youtube\.com\/watch\?v=([\w-]{11})/, /youtube\.com\/embed\/([\w-]{11})/, /youtube\.com\/shorts\/([\w-]{11})/];
  for (const re of pats) { const m = url.match(re); if (m) return m[1]; }
  return null;
}

let loadedVideoId = null;

async function loadBgMusic(url) {
  const videoId = extractYouTubeId(url);
  const playBtn = document.getElementById('btn-music-load');
  const titleEl = document.getElementById('music-title');
  if (!videoId) { showToast('올바른 YouTube 링크가 아닙니다.'); return; }

  await loadYouTubeApi();
  if (ytPlayer) {
    ytPlayer.loadVideoById(videoId);
  } else {
    await new Promise((resolve) => {
      ytPlayer = new YT.Player('yt-player', {
        videoId,
        playerVars: { autoplay: 1, loop: 1, playlist: videoId, controls: 0 },
        events: {
          onReady: (e) => { e.target.playVideo(); resolve(); },
          onStateChange: (e) => {
            // 재생/일시정지 버튼을 하나로 통합: 재생 중이면 일시정지, 아니면 재생하기
            if (e.data === YT.PlayerState.PLAYING) { playBtn.textContent = '⏸ 일시정지'; musicPlaying = true; }
            else if (e.data === YT.PlayerState.PAUSED) { playBtn.textContent = '▶ 재생하기'; musicPlaying = false; }
            refreshCaption();
          },
          onError: () => showToast('이 영상은 재생할 수 없습니다 (퍼가기 금지 등).'),
        },
      });
    });
    ytPlayer.setVolume(Number(document.getElementById('music-volume').value));
  }
  loadedVideoId = videoId;
  musicLoaded = true;
  musicPlaying = true;
  musicTitle = '';
  playBtn.textContent = '⏸ 일시정지';
  setTimeout(() => {
    try { musicTitle = ytPlayer.getVideoData()?.title || ''; titleEl.textContent = musicTitle; refreshCaption(); } catch {}
  }, 900);
  try { localStorage.setItem('bgMusicUrl', url); } catch {}
}

// "▶ 재생하기" 버튼: 처음이거나 링크가 바뀌었으면 로드/재생, 이미 로드됐으면 재생↔일시정지 토글
document.getElementById('btn-music-load').addEventListener('click', () => {
  const url = document.getElementById('music-url').value.trim();
  const id = url ? extractYouTubeId(url) : null;
  if (!musicLoaded || (id && id !== loadedVideoId)) {
    if (url) loadBgMusic(url);
    else showToast('YouTube 링크를 입력하세요.');
    return;
  }
  if (ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
  else ytPlayer.playVideo();
});
document.getElementById('music-volume').addEventListener('input', (e) => ytPlayer?.setVolume(Number(e.target.value)));
document.getElementById('btn-music-clear').addEventListener('click', () => {
  const i = document.getElementById('music-url'); i.value = ''; i.focus();
});
document.getElementById('btn-music-open-yt').addEventListener('click', () => {
  setSlideshowPaused(true);
  const url = document.getElementById('music-url').value.trim();
  const id = url ? extractYouTubeId(url) : null;
  window.open(id ? `https://www.youtube.com/watch?v=${id}` : 'https://www.youtube.com', '_blank');
});

// ---------- 하단 링크 ----------
document.getElementById('btn-reselect').addEventListener('click', (e) => {
  e.preventDefault();
  if (intervalHandle) clearInterval(intervalHandle);
  startPickerFlow();
});
document.getElementById('btn-logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
});

// ---------- 데모 (계정 없이 보기) ----------
let isDemoMode = false;

async function startDemo() {
  try {
    const res = await fetch('/demo/photos.json');
    if (!res.ok) throw new Error(`데모 데이터를 불러오지 못했습니다 (${res.status})`);
    const data = await res.json();
    isDemoMode = true;
    if (data.musicUrl) document.getElementById('music-url').value = data.musicUrl;
    boot(data.items || []);
  } catch (err) {
    const el = document.getElementById('login-error');
    el.textContent = err.message;
    el.classList.remove('hidden');
  }
}
document.getElementById('btn-demo').addEventListener('click', startDemo);

// ---------- 사용자 등록 안내 팝업 ----------
const registerModal = document.getElementById('register-modal');
document.getElementById('btn-register').addEventListener('click', (e) => {
  e.preventDefault();
  registerModal.classList.remove('hidden');
});
document.getElementById('btn-register-close').addEventListener('click', () => {
  registerModal.classList.add('hidden');
});
registerModal.addEventListener('click', (e) => {
  if (e.target === registerModal) registerModal.classList.add('hidden');
});
document.getElementById('btn-demo-home').addEventListener('click', (e) => {
  e.preventDefault();
  location.href = '/';
});

// ---------- 부팅 ----------
function boot(photos) {
  allPhotos = photos;
  currentIndex = 0;
  // 방향 필터는 새로 시작할 때 항상 전체보기로 초기화
  orientationMode = 'all';
  const allRadio = document.querySelector('#orientation-radios input[value="all"]');
  if (allRadio) allRadio.checked = true;
  if (!isDemoMode) {
    const saved = (() => { try { return localStorage.getItem('bgMusicUrl'); } catch { return null; } })();
    if (saved) document.getElementById('music-url').value = saved;
  }
  document.getElementById('demo-badge').classList.toggle('hidden', !isDemoMode);
  document.getElementById('account-links').classList.toggle('hidden', isDemoMode);
  document.getElementById('demo-links').classList.toggle('hidden', !isDemoMode);
  withSplash(() => { showSlideshow(); applyPeriod('all'); });
}

let loggedInName = null;

async function init() {
  const status = await api('/api/status').catch(() => ({ loggedIn: false }));
  if (!status.loggedIn) { withSplash(showLogin); return; }
  loggedInName = status.name || status.email || null;
  withSplash(startPickerFlow);
}

init();
