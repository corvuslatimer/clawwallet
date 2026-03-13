const {
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage,
} = require("@solana/web3.js");

const {
  PUMP_SDK,
  BONDING_CURVE_NEW_SIZE,
  bondingCurvePda,
  canonicalPumpPoolPda,
  feeSharingConfigPda,
} = require("@pump-fun/pump-sdk");

const { readPrivateKey } = require("../utils/wallet");
const { connection } = require("../solana/connection");
const { sendTx, computeUnitPriceMicrolamports } = require("../solana/tx");
const { sharingConfigPda } = require("../solana/pda");

/**
 * Redirect creator fee sharing for a Pump mint to a single recipient (100%).
 *
 * This mirrors the official Pump fee-sharing flow:
 *  - (optional) extend bonding curve if it's an older size
 *  - (optional) create fee sharing config (pool null if ungraduated, pool PDA if graduated)
 *  - update fee shares (with correct currentShareholders handling)
 */
async function redirectMintFees({
  privateKey,
  mint,
  recipient,
  bps = 10_000,
  simulate = false,
  commitment = "confirmed",
} = {}) {
  if (!privateKey) throw new Error("privateKey required");
  if (!mint) throw new Error("mint required");
  if (!recipient) throw new Error("recipient required");

  const bpsNum = Number(bps);
  if (!Number.isFinite(bpsNum) || bpsNum <= 0 || bpsNum > 10_000) {
    throw new Error("bps must be a number between 1 and 10000");
  }

  const signer = Keypair.fromSecretKey(readPrivateKey(privateKey));
  const mintPk = new PublicKey(mint);
  const recipientPk = new PublicKey(recipient);

  // Canonical PDAs used by Pump SDK
  const sharingConfigPk = feeSharingConfigPda(mintPk);
  const poolPk = canonicalPumpPoolPda(mintPk);
  const bondingCurvePk = bondingCurvePda(mintPk);

  // Fetch all required state in one RPC roundtrip
  const [sharingInfo, poolInfo, bondingCurveInfo] =
    await connection.getMultipleAccountsInfo(
      [sharingConfigPk, poolPk, bondingCurvePk],
      commitment
    );

  if (!bondingCurveInfo) {
    throw new Error(`Bonding curve account not found for mint ${mintPk.toBase58()}`);
  }

  const isGraduated = !!poolInfo;

  // Build instructions
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: computeUnitPriceMicrolamports(300_000),
    }),
  ];

  // If the bonding curve account is an older size, extend it first.
  // Pump SDK uses BONDING_CURVE_NEW_SIZE = 151.
  if (bondingCurveInfo.data.length < BONDING_CURVE_NEW_SIZE) {
    const extendIx = await PUMP_SDK.extendAccountInstruction({
      account: bondingCurvePk,
      user: signer.publicKey,
    });
    instructions.push(extendIx);
  }

  // Create fee sharing config if missing.
  if (!sharingInfo) {
    const createConfigIx = await PUMP_SDK.createFeeSharingConfig({
      creator: signer.publicKey,
      mint: mintPk,
      pool: isGraduated ? poolPk : null,
    });
    instructions.push(createConfigIx);
  }

  // Correctly determine current shareholders if config already exists.
  // (Needed because the update instruction can distribute fees to the old set before writing the new set.)
  let currentShareholders = [];
  if (sharingInfo) {
    try {
      const decoded = PUMP_SDK.decodeSharingConfig(sharingInfo);
      currentShareholders = (decoded.shareholders || []).map((s) => s.address);
    } catch (e) {
      throw new Error(
        `Sharing config exists (${sharingConfigPk.toBase58()}) but decode failed. ` +
          `Update @pump-fun/pump-sdk. Original error: ${e?.message || e}`
      );
    }
  } else {
    // Newly created config in this same tx starts with creator as shareholder.
    currentShareholders = [signer.publicKey];
  }

  // Redirect supports partial split. If bps < 10000, remainder stays with signer.
  const newShareholders = [{ address: recipientPk, shareBps: bpsNum }];
  if (bpsNum < 10_000) {
    newShareholders.push({ address: signer.publicKey, shareBps: 10_000 - bpsNum });
  }

  const updateIx = await PUMP_SDK.updateFeeShares({
    authority: signer.publicKey,
    mint: mintPk,
    currentShareholders,
    newShareholders,
  });
  instructions.push(updateIx);

  // Build + sign tx
  const { blockhash } = await connection.getLatestBlockhash(commitment);
  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([signer]);

  if (simulate) {
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      commitment,
    });

    return {
      simulated: true,
      signer: signer.publicKey.toBase58(),
      mint: mintPk.toBase58(),
      recipient: recipientPk.toBase58(),
      bps: bpsNum,
      bondingCurve: bondingCurvePk.toBase58(),
      sharingConfig: sharingConfigPk.toBase58(),
      isGraduated,
      usedPool: isGraduated ? poolPk.toBase58() : null,
      sharingConfigExists: !!sharingInfo,
      currentShareholders: currentShareholders.map((pk) => pk.toBase58()),
      logs: sim.value?.logs || null,
      err: sim.value?.err || null,
    };
  }

  const sig = await sendTx(tx, [signer]);

  return {
    signature: sig,
    signer: signer.publicKey.toBase58(),
    mint: mintPk.toBase58(),
    recipient: recipientPk.toBase58(),
    bps: bpsNum,
    bondingCurve: bondingCurvePk.toBase58(),
    sharingConfig: sharingConfigPk.toBase58(),
    isGraduated,
    usedPool: isGraduated ? poolPk.toBase58() : null,
    sharingConfigExisted: !!sharingInfo,
    previousShareholders: currentShareholders.map((pk) => pk.toBase58()),
    note: "Fee shares updated via official Pump SDK instruction builders.",
  };
}

function validatePdas({ mintPk, sharingConfig }) {
  if (!mintPk) throw new Error("mintPk required");
  if (!sharingConfig) throw new Error("sharingConfig required");

  const expectedSharingConfig = sharingConfigPda(mintPk);
  if (!expectedSharingConfig.equals(sharingConfig)) {
    throw new Error(
      `sharingConfig PDA mismatch: expected ${expectedSharingConfig.toBase58()}, got ${sharingConfig.toBase58()}`
    );
  }
}

module.exports = { redirectMintFees, validatePdas };
