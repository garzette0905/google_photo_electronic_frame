const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const cacheDir = () => path.join(app.getPath('userData'), 'photo-cache');
const metaPath = () => path.join(app.getPath('userData'), 'photos.json');

function ensureDir() {
  fs.mkdirSync(cacheDir(), { recursive: true });
}

function extFromMime(mimeType) {
  if (!mimeType) return 'jpg';
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('gif')) return 'gif';
  return 'jpg';
}

async function downloadVariant(accessToken, item, suffix, sizeParam) {
  ensureDir();
  const ext = extFromMime(item.mediaFile?.mimeType);
  const filePath = path.join(cacheDir(), `${item.id}_${suffix}.${ext}`);
  const url = `${item.mediaFile.baseUrl}=${sizeParam}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`이미지 다운로드 실패 (${res.status}) ${item.id}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  return filePath;
}

async function downloadFull(accessToken, item) {
  return downloadVariant(accessToken, item, 'full', 'w1920-h1080');
}

async function downloadThumb(accessToken, item) {
  return downloadVariant(accessToken, item, 'thumb', 'w200-h200-c');
}

function savePhotoList(list) {
  ensureDir();
  fs.writeFileSync(metaPath(), JSON.stringify(list, null, 2), 'utf-8');
}

function loadPhotoList() {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(metaPath(), 'utf-8'));
  } catch {
    return [];
  }
  // 이미지 파일이 실제로 남아있는 항목만 반환 (부분 삭제·손상 대비).
  const alive = list.filter((p) => {
    const filePath = decodeURI(String(p.fullUrl || '').replace(/^file:\/\//, ''));
    try { return fs.existsSync(filePath); } catch { return false; }
  });
  if (alive.length !== list.length) {
    if (alive.length === 0) { try { fs.rmSync(metaPath(), { force: true }); } catch {} }
    else savePhotoList(alive);
  }
  return alive;
}

function clearAll() {
  // 목록 파일을 먼저 지운다. 이미지 폴더 삭제가 느리거나 실패해도
  // 목록이 없으면 앱은 '사진 없음' 상태로 새로 시작하므로 깨진 썸네일이 안 뜬다.
  try { fs.rmSync(metaPath(), { force: true }); } catch {}
  try { fs.rmSync(cacheDir(), { recursive: true, force: true }); } catch {}
}

module.exports = { cacheDir, downloadFull, downloadThumb, savePhotoList, loadPhotoList, clearAll };
