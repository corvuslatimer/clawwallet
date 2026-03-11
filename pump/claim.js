const {
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  Keypair,
} = require('@solana/web3.js');
const { readPrivateKey, getPrivateKeyFromFile } = require('../utils/wallet');
const { anchorDisc } = require('../utils/encoding');
const { connection } = require('../solana/connection');
const { sendTx, computeUnitPriceMicrolamports } = require('../solana/tx');
const { PUMP_PROGRAM_ID } = require('../config/constants');
const { PUMP_EVENT_AUTHORITY, creatorVaultPda, bondingCurvePda, sharingConfigPda } = require('../solana/pda');
const { loadMap, getLaunch } = require('../launcher/launchermap');
const { validatePdas } = require('./feeSharing');

function enforceLauncherWalletIsolation({ launcherId, creatorPk, mint }) {
  if (!launcherId) return;
  const entry = getLaunch(launcherId);
  if (!entry) throw new Error(`launcherId '${launcherId}' not found in launchermap`);
  if (!entry.wallet) throw new Error(`launcherId '${launcherId}' has no wallet configured`);
  if (entry.wallet !== creatorPk.toBase58()) {
    throw new Error(`launcher wallet isolation failed: launcher '${launcherId}' is ${entry.wallet}, signer is ${creatorPk.toBase58()}`);
  }
  if (mint && Array.isArray(entry.mints) && entry.mints.length && !entry.mints.includes(mint)) {
    throw new Error(`launcher wallet isolation failed: mint ${mint} is not mapped to launcher '${launcherId}'`);
  }
}

async function claim({ keyfile, privateKey }) {
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
  const creator = Keypair.fromSecretKey(readPrivateKey(privateKey));
  const mintPk = new PublicKey(mint);

  enforceLauncherWalletIsolation({ launcherId, creatorPk: creator.publicKey, mint });

  const bondingCurve = bondingCurvePda(mintPk);
  const sharingConfig = sharingConfigPda(mintPk);
  const creatorVaultSharing = creatorVaultPda(sharingConfig);
  const creatorVaultLegacy = creatorVaultPda(creator.publicKey);

  validatePdas({ mintPk, creatorPk: creator.publicKey, sharingConfig });

  let vaultToUse = creatorVaultSharing;
  try {
    const info = await connection.getAccountInfo(creatorVaultSharing, 'confirmed');
    if (!info || info.lamports === 0) vaultToUse = creatorVaultLegacy;
  } catch {
    vaultToUse = creatorVaultLegacy;
  }

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 220_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(220_000) }),
    new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: false },
        { pubkey: sharingConfig, isSigner: false, isWritable: false },
        { pubkey: vaultToUse, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: anchorDisc('distribute_creator_fees'),
    })
  );

  tx.feePayer = creator.publicKey;
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(creator);

  if (simulate) {
    const sim = await connection.simulateTransaction(tx, [creator], 'confirmed');
    if (sim.value.err) {
      const err = new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
      err.logs = sim.value.logs || [];
      throw err;
    }
    return {
      simulated: true,
      tx: null,
      mint,
      claimed_sol: '0.000000',
      logs: sim.value.logs || [],
    };
  }

  let balanceBefore = 0n;
  try { balanceBefore = BigInt(await connection.getBalance(vaultToUse, 'confirmed')); } catch {}

  let sig;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
  } catch (e) {
    const beforeCreatorLamports = await connection.getBalance(creator.publicKey, 'confirmed').catch(() => 0);

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
    const afterCreatorLamports = await connection.getBalance(creator.publicKey, 'confirmed').catch(() => beforeCreatorLamports);
    const claimedLamports = BigInt(Math.max(0, afterCreatorLamports - beforeCreatorLamports));
    const claimedSol = (Number(claimedLamports) / LAMPORTS_PER_SOL).toFixed(6);

    let attribution = {};
    if (launcherId) {
      const map = loadMap();
      const entry = map[launcherId];
      if (entry?.mints?.length) {
        const share = Number(claimedSol) / entry.mints.length;
        entry.mints.forEach((m) => { attribution[m] = share.toFixed(6); });
      }
    }

    return {
      tx: sig,
      signature: sig,
      mint,
      claimed_sol: claimedSol,
      fee_mode: 'vault-delta-attribution',
      attribution,
      fallback_error: e.message,
    };
  }

  let balanceAfter = 0n;
  try { balanceAfter = BigInt(await connection.getBalance(vaultToUse, 'confirmed')); } catch {}
  const claimed = balanceBefore > balanceAfter ? (Number(balanceBefore - balanceAfter) / LAMPORTS_PER_SOL).toFixed(6) : 'unknown';

  return {
    tx: sig,
    signature: sig,
    mint,
    claimed_sol: claimed,
    fee_mode: 'distribute_creator_fees',
    sharingConfig: sharingConfig.toBase58(),
    creatorVault: vaultToUse.toBase58(),
  };
}

module.exports = { claim, claimMintFee };
