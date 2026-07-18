const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULTS = {
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  photoIntervalSec: 10,
  bgMusicUrl: '',
  userName: '',
};

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const current = load();
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

module.exports = { load, save };
