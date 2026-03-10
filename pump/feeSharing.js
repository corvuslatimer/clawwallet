const { PublicKey } = require('@solana/web3.js');
const { PUMP_FEE_CONFIG } = require('../solana/pda');
const { creatorVaultPda, bondingCurvePda, sharingConfigPda } = require('../solana/pda');
const { loadMap } = require('../launcher/launchermap');

function validatePdas({ mintPk, creatorPk, sharingConfig }) {
  const mint = mintPk instanceof PublicKey ? mintPk : new PublicKey(mintPk);
  const creator = creatorPk instanceof PublicKey ? creatorPk : new PublicKey(creatorPk);
  const derivedSharingConfig = sharingConfigPda(creator);

  if (sharingConfig) {
    const expected = sharingConfig instanceof PublicKey ? sharingConfig : new PublicKey(sharingConfig);
    if (!derivedSharingConfig.equals(expected)) {
      throw new Error(`PDA mismatch: sharingConfig expected ${derivedSharingConfig.toBase58()} got ${expected.toBase58()}`);
    }
  }

  return {
    bondingCurve: bondingCurvePda(mint),
    sharingConfig: derivedSharingConfig,
    creatorVault: creatorVaultPda(sharingConfig ? (sharingConfig instanceof PublicKey ? sharingConfig : new PublicKey(sharingConfig)) : creator),
    feeConfig: PUMP_FEE_CONFIG,
  };
}

function feeAttributionForLauncher({ launcherId, claimedSol }) {
  const map = loadMap();
  const entry = map[launcherId];
  if (!entry?.mints?.length) return {};
  const share = Number(claimedSol) / entry.mints.length;
  const out = {};
  for (const mint of entry.mints) out[mint] = share.toFixed(6);
  return out;
}

function getFeeSharingSummary({ launcherId = null } = {}) {
  const summary = {
    note: 'Claim supports distribute_creator_fees with collect_creator_fee fallback attribution.',
    recommendation: 'Use launcher wallet isolation + launchermap mint tracking for deterministic attribution.',
  };
  if (launcherId) {
    const map = loadMap();
    summary.launcher = map[launcherId] || null;
  }
  return summary;
}

module.exports = {
  validatePdas,
  feeAttributionForLauncher,
  getFeeSharingSummary,
};
