// NOTE: currently unused by cli.js command routes; kept for future per-launcher attribution logic.
const { getLaunch, loadMap } = require('./launchermap');

function byMint(mint) {
  const map = loadMap();
  return Object.entries(map)
    .filter(([, entry]) => Array.isArray(entry?.mints) && entry.mints.includes(mint))
    .map(([launcherId, entry]) => ({ launcherId, wallet: entry.wallet, mint }));
}

function byLauncher(launcherId) {
  const entry = getLaunch(launcherId);
  return entry ? { launcherId, ...entry } : null;
}

function splitEqual(totalAmount, launcherId) {
  const entry = getLaunch(launcherId);
  const mints = entry?.mints || [];
  if (!mints.length) return {};
  const total = Number(totalAmount) || 0;
  const share = total / mints.length;
  const out = {};
  for (const mint of mints) out[mint] = Number(share.toFixed(6));
  return out;
}

module.exports = { byMint, byLauncher, splitEqual };
