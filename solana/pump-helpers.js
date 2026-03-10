const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { connection } = require('./connection');
const { PUMP_FEE_RECIPIENT } = require('../config/constants');
const { PUMP_GLOBAL, bondingCurvePda } = require('./pda');
const { hashIndex } = require('../utils/encoding');

const BPS_DENOM = 10_000n;

function divCeil(a, b) {
  a = BigInt(a);
  b = BigInt(b);
  if (b === 0n) throw new Error('divCeil: division by zero');
  return (a + b - 1n) / b;
}

function clampInt(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

let _pumpGlobalCache = null;
let _pumpGlobalCacheTs = 0;

function parsePumpGlobalData(data) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data || []);
  if (data.length < 8 + 1 + 32 + 32 + 8 * 5) {
    throw new Error(`Global account too small: ${data.length} bytes`);
  }
  let o = 8;
  const initialized = data[o] === 1;
  o += 1;

  const authority = new PublicKey(data.slice(o, o + 32));
  o += 32;

  const feeRecipient = new PublicKey(data.slice(o, o + 32));
  o += 32;

  const initialVirtualTokenReserves = data.readBigUInt64LE(o);
  o += 8;

  const initialVirtualSolReserves = data.readBigUInt64LE(o);
  o += 8;

  const initialRealTokenReserves = data.readBigUInt64LE(o);
  o += 8;

  const tokenTotalSupply = data.readBigUInt64LE(o);
  o += 8;

  const feeBasisPoints = data.readBigUInt64LE(o);
  o += 8;

  const withdrawAuthority = new PublicKey(data.slice(o, o + 32));
  o += 32;

  const enableMigrate = data[o] === 1;
  o += 1;

  const poolMigrationFee = data.readBigUInt64LE(o);
  o += 8;

  const creatorFeeBasisPoints = data.readBigUInt64LE(o);
  o += 8;

  const feeRecipients = [];
  if (data.length >= o + 32 * 7) {
    for (let i = 0; i < 7; i++) {
      feeRecipients.push(new PublicKey(data.slice(o, o + 32)));
      o += 32;
    }
  }

  return {
    initialized,
    authority,
    feeRecipient,
    initialVirtualTokenReserves,
    initialVirtualSolReserves,
    initialRealTokenReserves,
    tokenTotalSupply,
    feeBasisPoints,
    withdrawAuthority,
    enableMigrate,
    poolMigrationFee,
    creatorFeeBasisPoints,
    feeRecipients,
  };
}

async function fetchPumpGlobalState({ maxAgeMs = 30_000 } = {}) {
  const now = Date.now();
  if (_pumpGlobalCache && (now - _pumpGlobalCacheTs) <= maxAgeMs) return _pumpGlobalCache;

  const info = await connection.getAccountInfo(PUMP_GLOBAL, 'confirmed');
  if (!info?.data) throw new Error('Failed to fetch Pump Global account');

  let parsed;
  try {
    parsed = parsePumpGlobalData(info.data);
  } catch (e) {
    parsed = {
      initialized: true,
      authority: PublicKey.default,
      feeRecipient: PUMP_FEE_RECIPIENT,
      initialVirtualTokenReserves: 1_073_000_191_000_000n,
      initialVirtualSolReserves: 30_000_000_000_000n,
      initialRealTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      feeBasisPoints: 95n,
      withdrawAuthority: PublicKey.default,
      enableMigrate: true,
      poolMigrationFee: 0n,
      creatorFeeBasisPoints: 30n,
      feeRecipients: [],
      _parseError: String(e?.message || e),
    };
  }

  const protocolFeeBps = clampInt(Number(parsed.feeBasisPoints), 0, 10_000);
  const creatorFeeBps = clampInt(Number(parsed.creatorFeeBasisPoints), 0, 10_000);
  const totalFeeBps = clampInt(protocolFeeBps + creatorFeeBps, 0, 10_000);

  _pumpGlobalCache = {
    ...parsed,
    protocolFeeBps,
    creatorFeeBps,
    totalFeeBps,
  };
  _pumpGlobalCacheTs = now;
  return _pumpGlobalCache;
}

function resolvePumpFeeRecipientForMint({ mintPk, bondingCurveState, globalState }) {
  const fallback = globalState?.feeRecipient || PUMP_FEE_RECIPIENT;
  const isMayhem = !!bondingCurveState?.isMayhem;

  const list = (globalState?.feeRecipients || []).filter(Boolean);
  if (!isMayhem) return fallback;

  if (!list.length) return fallback;

  const idx = hashIndex(mintPk.toBuffer(), list.length);
  return list[idx] || fallback;
}

function quoteBuyTokensOut({
  virtualTokenReserves,
  virtualSolReserves,
  spendableSolIn,
  protocolFeeBps,
  creatorFeeBps,
}) {
  const Vt = BigInt(virtualTokenReserves);
  const Vs = BigInt(virtualSolReserves);
  const spendable = BigInt(spendableSolIn);

  const pBps = BigInt(clampInt(protocolFeeBps, 0, 10_000));
  const cBps = BigInt(clampInt(creatorFeeBps, 0, 10_000));
  const totalBps = pBps + cBps;

  if (spendable <= 0n) return 0n;

  let netSol = (spendable * BPS_DENOM) / (BPS_DENOM + totalBps);

  let protocolFee = (pBps === 0n) ? 0n : divCeil(netSol * pBps, BPS_DENOM);
  let creatorFee = (cBps === 0n) ? 0n : divCeil(netSol * cBps, BPS_DENOM);
  let fees = protocolFee + creatorFee;

  if (netSol + fees > spendable) {
    const diff = (netSol + fees) - spendable;
    netSol = diff >= netSol ? 0n : (netSol - diff);

    protocolFee = (pBps === 0n) ? 0n : divCeil(netSol * pBps, BPS_DENOM);
    creatorFee = (cBps === 0n) ? 0n : divCeil(netSol * cBps, BPS_DENOM);
    fees = protocolFee + creatorFee;
    if (netSol + fees > spendable) {
      netSol = 0n;
    }
  }

  if (netSol <= 1n) return 0n;
  const effectiveNet = netSol - 1n;

  const denom = Vs + effectiveNet;
  if (denom <= 0n) return 0n;

  const out = (effectiveNet * Vt) / denom;
  return out < 0n ? 0n : out;
}

function quoteSellSolOut({
  virtualTokenReserves,
  virtualSolReserves,
  tokensIn,
  protocolFeeBps,
  creatorFeeBps,
}) {
  const Vt = BigInt(virtualTokenReserves);
  const Vs = BigInt(virtualSolReserves);
  const amt = BigInt(tokensIn);

  const pBps = BigInt(clampInt(protocolFeeBps, 0, 10_000));
  const cBps = BigInt(clampInt(creatorFeeBps, 0, 10_000));

  if (amt <= 0n) return 0n;
  if (Vt <= 0n || Vs <= 0n) return 0n;

  const newToken = Vt + amt;
  if (newToken <= 0n) return 0n;
  const newSol = (Vs * Vt) / newToken;
  const gross = Vs - newSol;
  if (gross <= 0n) return 0n;

  const protocolFee = (pBps === 0n) ? 0n : divCeil(gross * pBps, BPS_DENOM);
  const creatorFee = (cBps === 0n) ? 0n : divCeil(gross * cBps, BPS_DENOM);
  const fees = protocolFee + creatorFee;

  if (fees >= gross) return 0n;
  return gross - fees;
}

async function tokenProgramForMint(mintPk) {
  const info = await connection.getAccountInfo(mintPk);
  if (!info) throw new Error('Mint not found');
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

async function getBondingCurveState(mintPk, tokenProgramId) {
  const bondingCurve = bondingCurvePda(mintPk);
  const associatedBondingCurve = await getAssociatedTokenAddress(
    mintPk,
    bondingCurve,
    true,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  let info = null;
  let retries = 0;
  const maxRetries = 3;

  while (!info && retries < maxRetries) {
    try {
      info = await connection.getAccountInfo(bondingCurve, 'confirmed');
      if (!info && retries < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 500));
        retries++;
      }
    } catch (err) {
      if (retries < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 500));
        retries++;
      } else {
        throw err;
      }
    }
  }

  if (!info) return null;

  const d = info.data;
  const creator = new PublicKey(d.slice(49, 81));
  const isMayhem = d.length >= 82 ? (d[81] === 1) : false;

  return {
    bondingCurve,
    associatedBondingCurve,
    virtualTokenReserves: d.readBigUInt64LE(8),
    virtualSolReserves: d.readBigUInt64LE(16),
    realTokenReserves: d.length >= 32 ? d.readBigUInt64LE(24) : 0n,
    realSolReserves: d.length >= 40 ? d.readBigUInt64LE(32) : 0n,
    tokenTotalSupply: d.length >= 48 ? d.readBigUInt64LE(40) : 0n,
    complete: d[48] === 1,
    creator,
    isMayhem,
  };
}

module.exports = {
  divCeil,
  clampInt,
  parsePumpGlobalData,
  fetchPumpGlobalState,
  resolvePumpFeeRecipientForMint,
  quoteBuyTokensOut,
  quoteSellSolOut,
  tokenProgramForMint,
  getBondingCurveState,
};