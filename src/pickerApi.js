const BASE = 'https://photospicker.googleapis.com/v1';

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

function parseDurationMs(duration, fallbackMs) {
  if (typeof duration === 'string' && duration.endsWith('s')) {
    const secs = parseFloat(duration.slice(0, -1));
    if (!Number.isNaN(secs)) return secs * 1000;
  }
  return fallbackMs;
}

async function createSession(accessToken, requestId) {
  const res = await fetch(`${BASE}/sessions?requestId=${encodeURIComponent(requestId)}`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`선택 세션 생성 실패 (${res.status}): ${await res.text()}`);
  return res.json(); // { id, pickerUri, pollingConfig, expireTime, mediaItemsSet }
}

async function getSession(accessToken, sessionId) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw new Error(`세션 조회 실패 (${res.status}): ${await res.text()}`);
  return res.json();
}

async function deleteSession(accessToken, sessionId) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  });
  if (!res.ok && res.status !== 404) {
    // Non-fatal: cleanup failure shouldn't break the app.
  }
}

async function pollUntilMediaItemsSet(accessToken, sessionId, { onTick, signal } = {}) {
  let session = await getSession(accessToken, sessionId);
  const timeoutMs = parseDurationMs(session.pollingConfig?.timeoutIn, 10 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;

  while (!session.mediaItemsSet) {
    if (Date.now() > deadline) throw new Error('사진 선택 대기 시간이 초과되었습니다.');
    if (signal?.aborted) throw new Error('cancelled');
    const waitMs = parseDurationMs(session.pollingConfig?.pollInterval, 3000);
    await new Promise((r) => setTimeout(r, waitMs));
    onTick?.();
    session = await getSession(accessToken, sessionId);
  }
  return session;
}

async function listAllMediaItems(accessToken, sessionId, { onPage } = {}) {
  const items = [];
  let pageToken;
  do {
    const url = new URL(`${BASE}/mediaItems`);
    url.searchParams.set('sessionId', sessionId);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, { headers: authHeaders(accessToken) });
    if (!res.ok) throw new Error(`사진 목록 조회 실패 (${res.status}): ${await res.text()}`);
    const data = await res.json();
    const page = data.mediaItems || [];
    items.push(...page);
    onPage?.(items.length);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

module.exports = { createSession, getSession, deleteSession, pollUntilMediaItemsSet, listAllMediaItems };
