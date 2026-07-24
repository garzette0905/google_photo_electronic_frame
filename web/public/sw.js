// 서비스워커 — PWA 설치 및 "공유 타깃" 수신 전용.
// 구글 포토 등에서 공유하면 안드로이드가 이 앱으로 사진/동영상 파일을 POST(/share-target)로 보낸다.
// 그 파일들을 Cache Storage에 담아두고, 메인 페이지(/?shared=1)로 넘겨 슬라이드쇼로 재생한다.
// (그 외 요청은 건드리지 않고 그대로 네트워크로 흘려보낸다 — 캐싱하지 않음)

const SHARE_CACHE = 'shared-media-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShare(event.request));
  }
  // 그 외에는 respondWith를 호출하지 않아 브라우저 기본 동작(네트워크)에 맡긴다.
});

async function handleShare(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('photos').filter((f) => f && typeof f.size === 'number' && f.size > 0);

    const cache = await caches.open(SHARE_CACHE);
    // 이전에 공유했던 내용은 비우고 최신 공유분으로 교체
    for (const key of await cache.keys()) await cache.delete(key);

    const meta = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const key = `/shared-media/${i}`;
      await cache.put(key, new Response(f, {
        headers: { 'Content-Type': f.type || 'application/octet-stream' },
      }));
      meta.push({
        key,
        type: (f.type || '').startsWith('video') ? 'video' : 'photo',
        name: f.name || '',
        lastModified: f.lastModified || Date.now(),
      });
    }
    await cache.put('/shared-media/manifest', new Response(JSON.stringify(meta), {
      headers: { 'Content-Type': 'application/json' },
    }));

    return Response.redirect(meta.length ? '/?shared=1' : '/?shared=empty', 303);
  } catch (e) {
    return Response.redirect('/?shared=error', 303);
  }
}
