// 공유 보기 페이지 (로그인 불필요) — /f/<id> 에서 열리며 /shares/<id>/photos.json 을 읽어 재생.
const shareId = location.pathname.split('/').filter(Boolean).pop();

let photos = [];
let idx = 0;
let activeLayer = 'a';
let timer = null;

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
  document.getElementById('share-caption').textContent = formatDate(p.createTime);
}

function advance() { if (photos.length) { idx = (idx + 1) % photos.length; show(); } }
function resetTimer() { if (timer) clearInterval(timer); timer = setInterval(advance, 10000); }

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
let ytPlayer = null, ytReady = null, musicOn = false, musicUrl = '';
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
async function startMusic() {
  const id = musicUrl ? ytId(musicUrl) : null;
  if (!id) return;
  await loadYouTubeApi();
  if (!ytPlayer) {
    await new Promise((resolve) => {
      ytPlayer = new YT.Player('yt-player', {
        videoId: id,
        playerVars: { autoplay: 1, loop: 1, playlist: id, controls: 0 },
        events: { onReady: (e) => { e.target.playVideo(); resolve(); } },
      });
    });
  } else ytPlayer.playVideo();
  musicOn = true;
  updateMusicBtn();
}
function stopMusic() { ytPlayer?.pauseVideo(); musicOn = false; updateMusicBtn(); }
function updateMusicBtn() {
  const b = document.getElementById('btn-music');
  b.classList.toggle('playing', musicOn); // ▷ ↔ ⏸ 아이콘 전환
  b.style.opacity = musicOn ? '1' : '0.7';
}
document.getElementById('btn-music').addEventListener('click', () => (musicOn ? stopMusic() : startMusic()));

// ---- 초기화 ----
async function init() {
  try {
    const res = await fetch(`/shares/${shareId}/photos.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const data = await res.json();
    photos = data.items || [];
    musicUrl = data.musicUrl || '';
    if (!photos.length) throw new Error();
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

  // 음악이 있으면: 브라우저가 소리 자동재생을 막으므로 "탭하여 시작" 안내를 띄운다.
  if (musicUrl) {
    document.getElementById('btn-music').style.display = 'flex';
    const hint = document.getElementById('tap-hint');
    hint.classList.remove('hidden');
    hint.addEventListener('click', () => {
      hint.classList.add('hidden');
      startMusic();
      setFullscreen(true);
    }, { once: true });
  }
}
init();
