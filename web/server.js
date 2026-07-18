/**
 * 기억 조각 이어주기 - 웹 버전 백엔드
 *
 * 브라우저에 클라이언트 시크릿·토큰을 노출하지 않기 위해, OAuth 토큰 교환과
 * 구글 API 호출을 모두 이 서버에서 처리한다. 브라우저는 세션 쿠키만 들고
 * /api/* 엔드포인트를 호출하며, 실제 토큰은 서버 세션에만 보관된다.
 *
 * 필요 환경변수 (.env 또는 실행 시 지정):
 *   GOOGLE_CLIENT_ID     - 웹 애플리케이션 OAuth 클라이언트 ID
 *   GOOGLE_CLIENT_SECRET - 그 클라이언트의 시크릿
 *   BASE_URL             - 이 서버의 공개 주소 (기본 http://localhost:3000)
 *   SESSION_SECRET       - 세션 쿠키 서명 키 (미지정 시 임시값)
 *   PORT                 - 포트 (기본 3000)
 */

const path = require('path');
const express = require('express');
const session = require('express-session');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SCOPE = 'email profile https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

const PICKER_BASE = 'https://photospicker.googleapis.com/v1';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const app = express();
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'memory-frame-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30일
  })
);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('\n[경고] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 환경변수가 설정되지 않았습니다.');
  console.warn('       web/README.md의 설정 방법을 참고하세요.\n');
}

// ---------- 토큰 관리 ----------

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`토큰 교환 실패 (${res.status}): ${await res.text()}`);
  return res.json();
}

async function refreshToken(refresh) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`토큰 갱신 실패 (${res.status}): ${await res.text()}`);
  return res.json();
}

// 세션에서 유효한 access token을 확보한다 (만료 임박 시 자동 갱신).
async function getAccessToken(req) {
  const t = req.session.tokens;
  if (!t) throw new Error('NOT_LOGGED_IN');
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  if (!t.refreshToken) throw new Error('NOT_LOGGED_IN');
  const data = await refreshToken(t.refreshToken);
  t.accessToken = data.access_token;
  t.expiresAt = Date.now() + data.expires_in * 1000;
  return t.accessToken;
}

function requireLogin(handler) {
  return async (req, res) => {
    try {
      const token = await getAccessToken(req);
      await handler(req, res, token);
    } catch (err) {
      if (err.message === 'NOT_LOGGED_IN') return res.status(401).json({ error: '로그인이 필요합니다.' });
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  };
}

// ---------- OAuth ----------

app.get('/auth/login', (req, res) => {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('access_type', 'offline');
  // select_account: 구글이 이전 세션을 재사용해 자동으로 로그인해버리지 않고,
  // 계정 선택 화면을 항상 띄우게 한다. ("계정 다시 연결하기"가 다른 계정으로
  // 전환되도록 하려면 필수)
  url.searchParams.set('prompt', 'select_account consent');
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?auth_error=' + encodeURIComponent(error));
  if (!code) return res.redirect('/?auth_error=no_code');
  try {
    const data = await exchangeCode(code);

    // 구글의 "개별 권한 동의" 화면에서 사용자가 사진 선택 권한 체크박스를 빼먹으면,
    // 로그인 자체는 성공하지만 이후 사진 선택 단계에서야 스코프 부족 에러(403)로
    // 터진다. 로그인 시점에 바로 확인해서, 그런 경우 여기서 명확히 안내하고
    // 세션을 만들지 않는다 (사진 접근이 안 되는 반쪽짜리 로그인 방지).
    const grantedScopes = (data.scope || '').split(' ');
    if (!grantedScopes.includes('https://www.googleapis.com/auth/photospicker.mediaitems.readonly')) {
      return res.redirect('/?auth_error=missing_photos_scope');
    }

    // 사진 선택(Picker) 세션은 이 계정의 권한으로만 완료할 수 있다. 다른 계정으로
    // QR/링크를 열면 선택이 되지 않으므로, 화면에 표시해 사용자가 헷갈리지 않게 한다.
    const profile = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    req.session.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      email: profile?.email || null,
      name: profile?.name || null,
    };
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- 상태 ----------

app.get('/api/status', (req, res) => {
  const loggedIn = !!(req.session.tokens && req.session.tokens.refreshToken);
  res.json({
    loggedIn,
    email: loggedIn ? req.session.tokens.email || null : null,
    name: loggedIn ? req.session.tokens.name || null : null,
  });
});

// ---------- Picker API 프록시 ----------

app.post(
  '/api/picker/session',
  requireLogin(async (req, res, token) => {
    const r = await fetch(`${PICKER_BASE}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const s = await r.json();
    const qrDataUrl = await QRCode.toDataURL(s.pickerUri);
    res.json({ id: s.id, pickerUri: s.pickerUri, qrDataUrl, pollingConfig: s.pollingConfig });
  })
);

app.get(
  '/api/picker/session/:id',
  requireLogin(async (req, res, token) => {
    const r = await fetch(`${PICKER_BASE}/sessions/${encodeURIComponent(req.params.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const s = await r.json();
    res.json({ mediaItemsSet: !!s.mediaItemsSet, pollingConfig: s.pollingConfig });
  })
);

app.delete(
  '/api/picker/session/:id',
  requireLogin(async (req, res, token) => {
    await fetch(`${PICKER_BASE}/sessions/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
    res.json({ ok: true });
  })
);

// 선택된 사진 목록. baseUrl은 그대로 노출하지 않고, 인증이 필요한 다운로드는
// /img 프록시를 거치도록 변환해서 내려준다.
app.get(
  '/api/picker/media',
  requireLogin(async (req, res, token) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId 필요' });

    const items = [];
    let pageToken;
    do {
      const url = new URL(`${PICKER_BASE}/mediaItems`);
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('pageSize', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const data = await r.json();
      (data.mediaItems || []).forEach((it) => {
        const base = it.mediaFile?.baseUrl;
        if (!base) return;
        items.push({
          id: it.id,
          createTime: it.createTime,
          fullUrl: `/img?u=${encodeURIComponent(base)}&sz=w1920-h1080`,
          thumbUrl: `/img?u=${encodeURIComponent(base)}&sz=w300-h300-c`,
        });
      });
      pageToken = data.nextPageToken;
    } while (pageToken);

    items.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
    res.json({ items });
  })
);

// 이미지 프록시: baseUrl은 Authorization 헤더가 있어야 받을 수 있어 서버가 대신 받아 전달.
// 오픈 프록시가 되지 않도록 구글 사용자 콘텐츠 호스트만 허용한다.
app.get(
  '/img',
  requireLogin(async (req, res, token) => {
    const u = req.query.u;
    const sz = (req.query.sz || 'w800-h800').replace(/[^\w-]/g, '');
    if (!u) return res.status(400).send('missing url');
    let host;
    try { host = new URL(u).hostname; } catch { return res.status(400).send('bad url'); }
    if (!/(^|\.)googleusercontent\.com$/.test(host)) return res.status(403).send('forbidden host');

    const r = await fetch(`${u}=${sz}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return res.status(r.status).send('image fetch failed');
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3000');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  })
);

// ---------- 정적 파일 ----------

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n기억 조각 이어주기 (웹) 실행 중: ${BASE_URL}`);
  console.log(`OAuth 리디렉션 URI: ${REDIRECT_URI}\n`);
});
