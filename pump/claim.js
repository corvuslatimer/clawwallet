const {
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
} = require('@solana/web3.js');
const { readPrivateKey, getPrivateKeyFromFile } = require('../utils/wallet');
const { anchorDisc } = require('../utils/encoding');
const { connection } = require('../solana/connection');
const { sendTx, computeUnitPriceMicrolamports } = require('../solana/tx');
const { PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID } = require('../config/constants');
const { PUMP_EVENT_AUTHORITY, PUMP_FEE_CONFIG, creatorVaultPda, bondingCurvePda, sharingConfigPda } = require('../solana/pda');
const { loadMap } = require('../launcher/launchermap');

async function claim({ keyfile, privateKey }) {
  const { Keypair } = require('@solana/web3.js');
  const secret = privateKey ? readPrivateKey(privateKey) : getPrivateKeyFromFile(keyfile);
  const creator = Keypair.fromSecretKey(secret);
  const creatorVault = creatorVaultPda(creator.publicKey);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(200_000) }),
    new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: anchorDisc('collect_creator_fee'),
    })
  );

  const sig = await sendTx(tx, [creator]);
  return { signature: sig, creator: creator.publicKey.toBase58(), creatorVault: creatorVault.toBase58() };
}

async function claimMintFee({ privateKey, mint, launcherId = null, simulate = false } = {}) {
  const { Keypair } = require('@solana/web3.js');
  const creator = Keypair.fromSecretKey(readPrivateKey(privateKey));
  const mintPk = new PublicKey(mint);

  const bondingCurve = bondingCurvePda(mintPk);
  const sharingConfig = sharingConfigPda(creator.publicKey);
  const creatorVaultSharing = creatorVaultPda(sharingConfig);
  const creatorVaultLegacy = creatorVaultPda(creator.publicKey);

  let vaultToUse = creatorVaultSharing;
  try {
    const info = await connection.getAccountInfo(creatorVaultSharing, 'confirmed');
    if (!info || info.lamports === 0) vaultToUse = creatorVaultLegacy;
  } catch {
    vaultToUse = creatorVaultLegacy;
  }

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(200_000) }),
    new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: sharingConfig, isSigner: false, isWritable: true },
        { pubkey: vaultToUse, isSigner: false, isWritable: true },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: anchorDisc('distribute_creator_fees'),
    })
  );

  tx.feePayer = creator.publicKey;
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(creator);

  if (simulate) {
    const sim = await connection.simulateTransaction(tx, { sigVerify: true, replaceRecentBlockhash: true, commitment: 'confirmed' });
    if (sim.value.err) {
      const err = new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
      err.logs = sim.value.logs || [];
      throw err;
    }
    return { simulated: true, signature: null, mint, creator: creator.publicKey.toBase58(), logs: sim.value.logs || [] };
  }

  let balanceBefore = 0n;
  try { balanceBefore = BigInt(await connection.getBalance(vaultToUse, 'confirmed')); } catch {}

  let sig;
  let usedFallback = false;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
  } catch (e) {
    usedFallback = true;
    const balBefore = await connection.getBalance(vaultToUse, 'confirmed');

    const fallbackTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(200_000) }),
      new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
          { pubkey: creator.publicKey, isSigner: true, isWritable: true },
          { pubkey: creatorVaultLegacy, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: anchorDisc('collect_creator_fee'),
      })
    );

    sig = await sendTx(fallbackTx, [creator]);
    const balAfter = await connection.getBalance(creator.publicKey, 'confirmed');
    const delta = BigInt(Math.max(0, balAfter - balBefore));
    const deltaSOL = Number(delta) / LAMPORTS_PER_SOL;

    let attribution = {};
    if (launcherId) {
      const map = loadMap();
      const entry = map[launcherId];
      if (entry?.mints?.length) {
        const share = deltaSOL / entry.mints.length;
        entry.mints.forEach((m) => { attribution[m] = share.toFixed(6); });
      }
    }

    return {
      signature: sig,
      mint,
      creator: creator.publicKey.toBase58(),
      claimed_sol: deltaSOL.toFixed(6),
      fee_mode: 'legacy_attribution',
      attribution,
      fallback_error: e.message,
    };
  }

  let balanceAfter = 0n;
  try { balanceAfter = BigInt(await connection.getBalance(vaultToUse, 'confirmed')); } catch {}
  const claimed = balanceBefore > balanceAfter ? (Number(balanceBefore - balanceAfter) / LAMPORTS_PER_SOL).toFixed(6) : 'unknown';

  return {
    signature: sig,
    mint,
    creator: creator.publicKey.toBase58(),
    sharingConfig: sharingConfig.toBase58(),
    creatorVault: vaultToUse.toBase58(),
    claimed_sol: claimed,
    fee_mode: 'distribute_creator_fees',
    used_fallback: usedFallback,
  };
}

module.exports = { claim, claimMintFee };
