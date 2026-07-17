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
  try {
    return JSON.parse(fs.readFileSync(metaPath(), 'utf-8'));
  } catch {
    return [];
  }
}

module.exports = { cacheDir, downloadFull, downloadThumb, savePhotoList, loadPhotoList };
