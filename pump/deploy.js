const {
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  Keypair,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const { anchorDisc } = require('../utils/encoding');
const { readPrivateKey } = require('../utils/wallet');
const { connection } = require('../solana/connection');
const { computeUnitPriceMicrolamports } = require('../solana/tx');
const {
  PUMP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  SYSVAR_RENT,
} = require('../config/constants');
const {
  PUMP_GLOBAL,
  PUMP_EVENT_AUTHORITY,
  PUMP_GLOBAL_VOLUME_ACCUMULATOR,
  PUMP_FEE_CONFIG,
  bondingCurvePda,
  mintAuthorityPda,
  metadataPda,
  creatorVaultPda,
  userVolumeAccumulatorPda,
  sharingConfigPda,
} = require('../solana/pda');
const { fetchPumpGlobalState, quoteBuyTokensOut } = require('./common');
const { validatePdas } = require('./feeSharing');
const { getLaunch, addLaunch } = require('../launcher/launchermap');

function encodeOptionBool(v) {
  if (v === null || v === undefined) return Buffer.from([0]);
  return Buffer.from([1, v ? 1 : 0]);
}

function enforceLauncherWalletIsolation({ launcherId, creatorPk }) {
  if (!launcherId) return;
  const entry = getLaunch(launcherId);
  if (!entry) throw new Error(`launcherId '${launcherId}' not found in launchermap. Set it with: launchermap set ${launcherId} <WALLET_PUBKEY>`);
  if (!entry.wallet) throw new Error(`launcherId '${launcherId}' has no wallet set in launchermap`);
  if (entry.wallet !== creatorPk.toBase58()) {
    throw new Error(`launcher wallet isolation failed: launcher '${launcherId}' is mapped to ${entry.wallet}, but signer is ${creatorPk.toBase58()}`);
  }
}

async function deploy2({
  privateKey,
  mintKeypair,
  name,
  symbol,
  metadataUri,
  recipients = [],
  bps = [],
  initialBuySol = 0,
  slippageBps = 1000,
  simulate = false,
  launcherId = null,
} = {}) {
  const creator = Keypair.fromSecretKey(readPrivateKey(privateKey));
  if (!mintKeypair) throw new Error('mintKeypair required');
  if (!name || name.length > 32) throw new Error('Name must be 1-32 characters');
  if (!symbol || symbol.length > 10) throw new Error('Symbol must be 1-10 characters');
  if (!metadataUri) throw new Error('Metadata URI required');
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('At least one recipient required');
  if (recipients.length !== bps.length) throw new Error('recipients and bps arrays must match length');

  const totalBps = bps.reduce((a, b) => a + Number(b), 0);
  if (totalBps !== 10_000) throw new Error(`BPS values must sum to 10000, got ${totalBps}`);

  enforceLauncherWalletIsolation({ launcherId, creatorPk: creator.publicKey });

  const mintPk = mintKeypair.publicKey;
  const recipientPks = recipients.map((r) => new PublicKey(r));

  const sharingConfig = sharingConfigPda(creator.publicKey);
  const creatorVault = creatorVaultPda(sharingConfig);
  const bondingCurve = bondingCurvePda(mintPk);
  const associatedBondingCurve = await getAssociatedTokenAddress(
    mintPk,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const metadata = metadataPda(mintPk);
  const mintAuthority = mintAuthorityPda();
  const userVolumeAccumulator = userVolumeAccumulatorPda(creator.publicKey);

  validatePdas({ mintPk, creatorPk: creator.publicKey, sharingConfig });

  const numRecipients = recipientPks.length;
  const feeConfigDataLen = 8 + 1 + numRecipients * (32 + 2);
  const feeConfigData = Buffer.alloc(feeConfigDataLen);
  let fco = 0;
  anchorDisc('create_fee_sharing_config').copy(feeConfigData, fco); fco += 8;
  feeConfigData.writeUInt8(numRecipients, fco); fco += 1;
  for (let i = 0; i < numRecipients; i++) {
    recipientPks[i].toBuffer().copy(feeConfigData, fco); fco += 32;
    feeConfigData.writeUInt16LE(Number(bps[i]), fco); fco += 2;
  }

  const feeConfigIx = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: sharingConfig, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: feeConfigData,
  });

  const nameBytes = Buffer.from(name, 'utf8');
  const symbolBytes = Buffer.from(symbol, 'utf8');
  const uriBytes = Buffer.from(metadataUri, 'utf8');

  const createDataLen = 8 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length + 32;
  const createData = Buffer.alloc(createDataLen);
  let offset = 0;
  anchorDisc('create_v2').copy(createData, offset); offset += 8;
  createData.writeUInt32LE(nameBytes.length, offset); offset += 4;
  nameBytes.copy(createData, offset); offset += nameBytes.length;
  createData.writeUInt32LE(symbolBytes.length, offset); offset += 4;
  symbolBytes.copy(createData, offset); offset += symbolBytes.length;
  createData.writeUInt32LE(uriBytes.length, offset); offset += 4;
  uriBytes.copy(createData, offset); offset += uriBytes.length;
  creator.publicKey.toBuffer().copy(createData, offset);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(500_000) }),
    feeConfigIx,
    new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: mintPk, isSigner: true, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: MPL_TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: sharingConfig, isSigner: false, isWritable: true },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PUMP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: true },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      ],
      data: createData,
    })
  );

  if (Number(initialBuySol) > 0) {
    const globalState = await fetchPumpGlobalState();
    const userAta = await getAssociatedTokenAddress(mintPk, creator.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    if (!await connection.getAccountInfo(userAta).catch(() => null)) {
      tx.add(createAssociatedTokenAccountInstruction(creator.publicKey, userAta, creator.publicKey, mintPk, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }

    const tradeLamportsBig = BigInt(Math.floor(Number(initialBuySol) * LAMPORTS_PER_SOL));
    const sBps = Number.isFinite(slippageBps) ? Math.max(0, Math.floor(slippageBps)) : 1000;
    const tokensOut = quoteBuyTokensOut({
      virtualTokenReserves: BigInt(globalState.initialVirtualTokenReserves),
      virtualSolReserves: BigInt(globalState.initialVirtualSolReserves),
      spendableSolIn: tradeLamportsBig,
      protocolFeeBps: globalState.protocolFeeBps,
      creatorFeeBps: globalState.creatorFeeBps,
    });
    if (tokensOut <= 0n) throw new Error('Initial buy quote returned 0 tokens out; increase initialBuySol');

    const maxSolCost = tradeLamportsBig + (tradeLamportsBig * BigInt(sBps)) / 10_000n;
    const buyData = Buffer.concat([anchorDisc('buy'), Buffer.alloc(8), Buffer.alloc(8), encodeOptionBool(true)]);
    buyData.writeBigUInt64LE(tokensOut, 8);
    buyData.writeBigUInt64LE(maxSolCost, 16);

    tx.add(new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: globalState.feeRecipient, isSigner: false, isWritable: true },
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PUMP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: buyData,
    }));
  }

  tx.feePayer = creator.publicKey;
  const latestBlockhash = await connection.getLatestBlockhash('processed');
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.sign(creator, mintKeypair);

  if (simulate) {
    const sim = await connection.simulateTransaction(tx, [creator, mintKeypair], 'processed');
    if (sim.value.err) {
      const err = new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
      err.logs = sim.value.logs || [];
      throw err;
    }
    return {
      simulated: true,
      tx: null,
      mint: mintPk.toBase58(),
      creator: creator.publicKey.toBase58(),
      fee_mode: 'sharing_config+creator_vault',
      recipients: recipientPks.map((r, i) => ({ wallet: r.toBase58(), bps: Number(bps[i]) })),
      logs: sim.value.logs || [],
    };
  }

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5, preflightCommitment: 'processed' });
  await connection.confirmTransaction({ signature: sig, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight }, 'confirmed');

  if (launcherId) {
    addLaunch({ launcherId, mint: mintPk.toBase58(), creatorWallet: creator.publicKey.toBase58() });
  }

  return {
    tx: sig,
    signature: sig,
    mint: mintPk.toBase58(),
    creator: creator.publicKey.toBase58(),
    fee_mode: 'sharing_config+creator_vault',
    recipients: recipientPks.map((r, i) => ({ wallet: r.toBase58(), bps: Number(bps[i]) })),
    sharingConfig: sharingConfig.toBase58(),
    creatorVault: creatorVault.toBase58(),
  };
}

async function deploy(opts = {}) {
  const creator = Keypair.fromSecretKey(readPrivateKey(opts.privateKey));
  return deploy2({
    ...opts,
    recipients: [creator.publicKey.toBase58()],
    bps: [10_000],
  });
}

module.exports = { deploy, deploy2 };
