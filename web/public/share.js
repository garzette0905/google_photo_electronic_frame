// 공유 보기 페이지 (로그인 불필요) — /f/<id> 에서 열리며 /shares/<id>/photos.json 을 읽어 재생.
const shareId = location.pathname.split('/').filter(Boolean).pop();

let photos = [];
let idx = 0;
let activeLayer = 'a';
let timer = null;
let intervalMs = 10000; // 링크 생성 시점의 전환 간격 (없으면 10초)

function formatDate(iso) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(d);
  return `${date} · ${time}`;
}

function preload(url) {
  return new Promise((resolve) => { const im = new Image(); im.onload = resolve; im.onerror = resolve; im.src = url; });
}

async function show() {
  if (!photos.length) return;
  const p = photos[idx];
  const req = idx;
  const next = document.getElementById(activeLayer === 'a' ? 'photo-b' : 'photo-a');
  const prev = document.getElementById(activeLayer === 'a' ? 'photo-a' : 'photo-b');
  await preload(p.fullUrl);
  if (req !== idx) return;
  next.src = p.fullUrl;
  next.classList.add('active');
  prev.classList.remove('active');
  activeLayer = activeLayer === 'a' ? 'b' : 'a';
  renderCaption();
  updateProgress();
}

// 캡션: 우측 하단에 날짜(시계 자리) + 그 아래 곡목(♪). 소리 여부와 무관하게 곡목을 표시한다.
function renderCaption() {
  const p = photos[idx];
  const el = document.getElementById('share-caption');
  el.textContent = '';
  const lines = [];
  if (p) lines.push(formatDate(p.createTime));
  if (musicTitle) lines.push('♪ ' + musicTitle);
  lines.forEach((ln, i) => {
    if (i > 0) el.appendChild(document.createElement('br'));
    el.appendChild(document.createTextNode(ln));
  });
}

// 하단 진행바: 현재 사진이 전체에서 몇 번째인지 (희미한 참고용)
function updateProgress() {
  const fill = document.getElementById('progress-strip-fill');
  if (!fill) return;
  fill.style.width = (photos.length ? ((idx + 1) / photos.length) * 100 : 0) + '%';
}

function advance() { if (photos.length) { idx = (idx + 1) % photos.length; show(); } }
function resetTimer() { if (timer) clearInterval(timer); timer = setInterval(advance, intervalMs); }

// ---- 전체화면 ----
function setFullscreen(on) {
  document.body.classList.toggle('fullscreen', on);
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
document.getElementById('btn-fullscreen').addEventListener('click', () =>
  setFullscreen(!document.body.classList.contains('fullscreen')));
document.addEventListener('fullscreenchange', () =>
  document.body.classList.toggle('fullscreen', !!document.fullscreenElement));

// ---- 배경음악 (선택) ----
// 기본은 "무음": 음소거 자동재생으로 곡 제목만 얻어 캡션에 표시하고, ▶ 버튼을 눌러야 소리가 난다.
let ytPlayer = null, ytReady = null, soundOn = false, musicUrl = '', musicTitle = '';
function loadYouTubeApi() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    window.onYouTubeIframeAPIReady = resolve;
    const t = document.createElement('script'); t.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(t);
  });
  return ytReady;
}
function ytId(url) {
  const pats = [/youtu\.be\/([\w-]{11})/, /youtube\.com\/watch\?v=([\w-]{11})/, /youtube\.com\/embed\/([\w-]{11})/, /youtube\.com\/shorts\/([\w-]{11})/];
  for (const re of pats) { const m = url.match(re); if (m) return m[1]; }
  return null;
}
// 무음으로 플레이어를 만들어(음소거 자동재생) 곡 제목을 얻고 캡션에 표시한다. 소리는 나지 않는다.
async function initMusic() {
  const id = musicUrl ? ytId(musicUrl) : null;
  if (!id) return;
  await loadYouTubeApi();
  await new Promise((resolve) => {
    ytPlayer = new YT.Player('yt-player', {
      videoId: id,
      playerVars: { autoplay: 1, mute: 1, loop: 1, playlist: id, controls: 0 },
      events: { onReady: (e) => { try { e.target.mute(); e.target.playVideo(); } catch {} resolve(); } },
    });
  });
  // 제목 읽기 (소리와 무관). 메타데이터 로딩 지연 대비 두 번 시도.
  const readTitle = () => { try { musicTitle = ytPlayer.getVideoData()?.title || musicTitle; renderCaption(); } catch {} };
  setTimeout(readTitle, 900);
  setTimeout(readTitle, 2500);
  document.getElementById('btn-music').style.display = 'flex';
  updateMusicBtn();
}
function playSound() {
  if (!ytPlayer) return;
  try { ytPlayer.unMute(); ytPlayer.setVolume(80); ytPlayer.playVideo(); } catch {}
  soundOn = true;
  updateMusicBtn();
}
function muteSound() {
  if (!ytPlayer) return;
  try { ytPlayer.mute(); } catch {} // 계속 무음으로 재생(곡목 유지), 소리만 끔
  soundOn = false;
  updateMusicBtn();
}
function updateMusicBtn() {
  const b = document.getElementById('btn-music');
  b.classList.toggle('playing', soundOn); // ▷(무음) ↔ ⏸(소리 켜짐)
  b.style.opacity = soundOn ? '1' : '0.7';
  b.title = soundOn ? '소리 끄기' : '소리 켜기';
}
document.getElementById('btn-music').addEventListener('click', () => (soundOn ? muteSound() : playSound()));

// ---- 홈으로 이동 ----
document.getElementById('btn-home').addEventListener('click', () => {
  try { ytPlayer?.pauseVideo(); } catch {}
  location.href = '/';
});

// ---- 초기화 ----
async function init() {
  try {
    const res = await fetch(`/shares/${shareId}/photos.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const data = await res.json();
    photos = data.items || [];
    musicUrl = data.musicUrl || '';
    if (!photos.length) throw new Error();

    // 링크 생성 시점에 선택했던 제목·전환 간격·전환 효과 적용
    const view = document.querySelector('.share-view');
    const title = (data.title || '').trim();
    if (title) {
      const t = document.getElementById('share-title');
      t.textContent = title;
      t.classList.remove('hidden');
    }
    const effect = ['fade', 'slide', 'kenburns'].includes(data.effect) ? data.effect : 'fade';
    view.classList.add('fx-' + effect);
    const sec = Math.min(60, Math.max(3, Number(data.intervalSec) || 10));
    intervalMs = sec * 1000;
    view.style.setProperty('--kb-duration', sec + 's');
  } catch {
    document.getElementById('share-loading').classList.add('hidden');
    const e = document.getElementById('share-error');
    e.textContent = '공유 사진을 찾을 수 없습니다. 링크가 만료되었거나 삭제되었을 수 있습니다.';
    e.classList.remove('hidden');
    return;
  }

  document.getElementById('share-loading').classList.add('hidden');
  idx = 0;
  await show();
  resetTimer();

  // 음악이 있으면 무음으로 시작해 곡목만 표시(소리는 ▶ 버튼으로). 자동으로 소리 내지 않음.
  if (musicUrl) initMusic();
}
init();
