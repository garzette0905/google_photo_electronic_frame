const crypto = require('crypto');
const http = require('http');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'profile https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newRequestId() {
  return crypto.randomUUID();
}

const RESULT_PAGE = (ok) => `<html><body style="font-family:sans-serif;text-align:center;padding-top:80px;">
  <h2>${ok ? '로그인이 완료되었습니다.' : '로그인에 실패했습니다.'}</h2>
  <p>이 창은 닫고 앱으로 돌아가셔도 됩니다.</p>
</body></html>`;

/**
 * Runs the "installed app" OAuth flow (RFC 8252): a one-shot local server catches
 * the redirect on 127.0.0.1, the system browser handles the actual Google login/consent,
 * then the code is exchanged for tokens using PKCE.
 */
async function loginWithBrowser({ clientId, clientSecret, openUrl }) {
  const codeVerifier = base64url(crypto.randomBytes(64));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = crypto.randomUUID();

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const code = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      const receivedCode = url.searchParams.get('code');
      const receivedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(RESULT_PAGE(!error));
      setTimeout(() => server.close(), 50);

      if (error) reject(new Error(`로그인 거부/실패: ${error}`));
      else if (receivedState !== state) reject(new Error('state 값이 일치하지 않습니다.'));
      else if (receivedCode) resolve(receivedCode);
      else reject(new Error('인증 코드가 전달되지 않았습니다.'));
    });

    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPE);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    openUrl(authUrl.toString());
  });

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`토큰 교환 실패 (${res.status}): ${await res.text()}`);
  }
  const tokenData = await res.json(); // { access_token, refresh_token, expires_in, scope, ... }

  // 구글의 "개별 권한 동의" 화면에서 사진 선택 권한 체크박스를 빼먹으면 로그인
  // 자체는 성공하지만, 이후 사진 선택 단계에서야 스코프 부족(403)으로 터진다.
  // 로그인 시점에 바로 확인해서 여기서 명확히 알려준다.
  const grantedScopes = (tokenData.scope || '').split(' ');
  if (!grantedScopes.includes('https://www.googleapis.com/auth/photospicker.mediaitems.readonly')) {
    throw new Error(
      '로그인 중 "Google 포토" 권한에 동의하지 않아 사진을 가져올 수 없습니다. ' +
      '다시 로그인하시고, 동의 화면에서 사진 관련 권한 체크박스를 꼭 체크해주세요.'
    );
  }

  return tokenData;
}

// 사진 선택(Picker) 세션은 로그인한 계정의 권한으로만 완료할 수 있어, 화면에
// "이 계정으로만 가능합니다"를 표시하려고 이름을 가져온다. scope에 이미 'profile'이
// 포함되어 있어 별도 스코프 추가 없이 조회 가능하다.
async function fetchUserInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json(); // { name, email, picture, ... }
}

async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`토큰 갱신 실패 (${res.status}): ${await res.text()}`);
  }
  return res.json(); // { access_token, expires_in, ... }
}

module.exports = { newRequestId, loginWithBrowser, refreshAccessToken, fetchUserInfo };
