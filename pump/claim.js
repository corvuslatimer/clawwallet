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
const { PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID } = require('../config/constants');
const { PUMP_GLOBAL, PUMP_FEE_CONFIG, PUMP_EVENT_AUTHORITY, creatorVaultPda, bondingCurvePda, sharingConfigPda } = require('../solana/pda');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { tokenProgramForMint, getBondingCurveState } = require('./common');
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

  let vaultToUse = creatorVaultLegacy;
  let useSharing = false;
  try {
    const info = await connection.getAccountInfo(creatorVaultSharing, 'confirmed');
    if (info && info.lamports > 0) {
      vaultToUse = creatorVaultSharing;
      useSharing = true;
    }
  } catch {
    vaultToUse = creatorVaultLegacy;
    useSharing = false;
  }

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(300_000) }),
  ];

  let curve = null;
  let includeSwapTransfer = false;
  if (useSharing) {
    const tokenProgramId = await tokenProgramForMint(mintPk);
    curve = await getBondingCurveState(mintPk, tokenProgramId);

    if (curve?.complete) {
      includeSwapTransfer = true;
      const coinCreatorVaultAuthority = PublicKey.findProgramAddressSync(
        [Buffer.from('creator_vault'), sharingConfig.toBuffer()],
        PUMP_SWAP_PROGRAM_ID
      )[0];
      const pumpSwapEventAuthority = PublicKey.findProgramAddressSync(
        [Buffer.from('__event_authority')],
        PUMP_SWAP_PROGRAM_ID
      )[0];
      const solMint = new PublicKey('So11111111111111111111111111111111111111112');
      const coinCreatorVaultWsolAta = await getAssociatedTokenAddress(
        solMint,
        coinCreatorVaultAuthority,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      instructions.push(new TransactionInstruction({
        programId: PUMP_SWAP_PROGRAM_ID,
        keys: [
          { pubkey: solMint, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: sharingConfig, isSigner: false, isWritable: true },
          { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: true },
          { pubkey: coinCreatorVaultWsolAta, isSigner: false, isWritable: true },
          { pubkey: vaultToUse, isSigner: false, isWritable: true },
          { pubkey: pumpSwapEventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_SWAP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: anchorDisc('transfer_creator_fees_to_pump'),
      }));
    }

    instructions.push(new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: false },
        { pubkey: sharingConfig, isSigner: false, isWritable: false },
        { pubkey: vaultToUse, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: anchorDisc('distribute_creator_fees'),
    }));
  } else {
    instructions.push(new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: vaultToUse, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: anchorDisc('collect_creator_fee'),
    }));
  }

  const tx = new Transaction().add(...instructions);

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
      fee_mode: useSharing ? 'distribute_creator_fees' : 'collect_creator_fee',
    };
  }

  let balanceBefore = 0n;
  try { balanceBefore = BigInt(await connection.getBalance(vaultToUse, 'confirmed')); } catch {}

  let sig;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
  } catch (e) {
    if (includeSwapTransfer && useSharing) {
      const retryTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(300_000) }),
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
            { pubkey: creator.publicKey, isSigner: true, isWritable: true },
            { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
            { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
            { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: anchorDisc('distribute_creator_fees'),
        })
      );
      retryTx.feePayer = creator.publicKey;
      const retryLatest = await connection.getLatestBlockhash('confirmed');
      retryTx.recentBlockhash = retryLatest.blockhash;
      retryTx.sign(creator);
      sig = await connection.sendRawTransaction(retryTx.serialize(), { skipPreflight: false, maxRetries: 5 });
      await connection.confirmTransaction({ signature: sig, blockhash: retryLatest.blockhash, lastValidBlockHeight: retryLatest.lastValidBlockHeight }, 'confirmed');
    } else {
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
  }

  let balanceAfter = 0n;
  try { balanceAfter = BigInt(await connection.getBalance(vaultToUse, 'confirmed')); } catch {}
  const claimed = balanceBefore > balanceAfter ? (Number(balanceBefore - balanceAfter) / LAMPORTS_PER_SOL).toFixed(6) : 'unknown';

  return {
    tx: sig,
    signature: sig,
    mint,
    claimed_sol: claimed,
    fee_mode: useSharing ? 'distribute_creator_fees' : 'collect_creator_fee',
    sharingConfig: useSharing ? sharingConfig.toBase58() : null,
    creatorVault: vaultToUse.toBase58(),
  };
}

module.exports = { claim, claimMintFee };
