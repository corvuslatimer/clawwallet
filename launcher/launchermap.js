const fs = require('fs');
const path = require('path');

const MAP_PATH = path.resolve(__dirname, 'launchermap.json');

function loadRaw() {
  if (!fs.existsSync(MAP_PATH)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    if (Array.isArray(parsed)) {
      // legacy transitional array format
      const map = {};
      for (const item of parsed) {
        if (!item?.launcherId) continue;
        if (!map[item.launcherId]) map[item.launcherId] = { wallet: item.creatorWallet || null, mints: [] };
        if (item.creatorWallet) map[item.launcherId].wallet = item.creatorWallet;
        if (item.mint && !map[item.launcherId].mints.includes(item.mint)) map[item.launcherId].mints.push(item.mint);
      }
      return map;
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveMap(map) {
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
}

function loadMap() {
  return loadRaw();
}

function listLaunches() {
  return loadMap();
}

function getLaunch(launcherId) {
  if (!launcherId) return null;
  return loadMap()[launcherId] || null;
}

function setLauncherWallet({ launcherId, wallet }) {
  if (!launcherId || !wallet) throw new Error('Need launcherId and wallet');
  const map = loadMap();
  if (!map[launcherId]) map[launcherId] = { wallet, mints: [] };
  else map[launcherId].wallet = wallet;
  saveMap(map);
  return map[launcherId];
}

function addLaunch({ launcherId, mint, creatorWallet }) {
  if (!launcherId || !mint || !creatorWallet) throw new Error('Need launcherId, mint, creatorWallet');
  const map = loadMap();
  if (!map[launcherId]) map[launcherId] = { wallet: creatorWallet, mints: [] };
  if (creatorWallet) map[launcherId].wallet = creatorWallet;
  if (!map[launcherId].mints.includes(mint)) map[launcherId].mints.push(mint);
  saveMap(map);
  return map[launcherId];
}

module.exports = { MAP_PATH, loadMap, saveMap, listLaunches, getLaunch, setLauncherWallet, addLaunch };
