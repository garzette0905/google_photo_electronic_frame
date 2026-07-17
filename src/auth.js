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
  return res.json(); // { access_token, refresh_token, expires_in, ... }
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

module.exports = { newRequestId, loginWithBrowser, refreshAccessToken };
