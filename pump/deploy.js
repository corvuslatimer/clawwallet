const {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
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
const { PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, MPL_TOKEN_METADATA_PROGRAM_ID, SYSVAR_RENT } = require('../config/constants');
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
} = require('../solana/pda');
const { fetchPumpGlobalState, quoteBuyTokensOut } = require('./common');

function encodeOptionBool(v) {
  if (v === null || v === undefined) return Buffer.from([0]);
  return Buffer.from([1, v ? 1 : 0]);
}

async function deploy({
  privateKey,
  name,
  symbol,
  metadataUri,
  initialBuySol = 0,
  slippageBps = 1000,
  simulate = false,
  mintKeypair = null,
} = {}) {
  const { Keypair } = require('@solana/web3.js');
  const creator = Keypair.fromSecretKey(readPrivateKey(privateKey));
  if (!mintKeypair) throw new Error('mintKeypair required');
  const mint = mintKeypair;

  if (!name || name.length > 32) throw new Error('Name must be 1-32 characters');
  if (!symbol || symbol.length > 10) throw new Error('Symbol must be 1-10 characters');
  if (!metadataUri) throw new Error('Metadata URI required');

  const bondingCurve = bondingCurvePda(mint.publicKey);
  const associatedBondingCurve = await getAssociatedTokenAddress(mint.publicKey, bondingCurve, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const metadata = metadataPda(mint.publicKey);
  const mintAuthority = mintAuthorityPda();
  const creatorVault = creatorVaultPda(creator.publicKey);
  const userVolumeAccumulator = userVolumeAccumulatorPda(creator.publicKey);

  const nameBytes = Buffer.from(name, 'utf8');
  const symbolBytes = Buffer.from(symbol, 'utf8');
  const uriBytes = Buffer.from(metadataUri, 'utf8');

  const dataLen = 8 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length + 32;
  const data = Buffer.alloc(dataLen);
  let offset = 0;
  anchorDisc('create').copy(data, offset); offset += 8;
  data.writeUInt32LE(nameBytes.length, offset); offset += 4;
  nameBytes.copy(data, offset); offset += nameBytes.length;
  data.writeUInt32LE(symbolBytes.length, offset); offset += 4;
  symbolBytes.copy(data, offset); offset += symbolBytes.length;
  data.writeUInt32LE(uriBytes.length, offset); offset += 4;
  uriBytes.copy(data, offset); offset += uriBytes.length;
  creator.publicKey.toBuffer().copy(data, offset);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(400_000) }),
    new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: mint.publicKey, isSigner: true, isWritable: true },
        { pubkey: mintAuthority, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: MPL_TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: creator.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: PUMP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: true },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      ],
      data,
    })
  );

  if (Number(initialBuySol) > 0) {
    const globalState = await fetchPumpGlobalState();
    const userAta = await getAssociatedTokenAddress(mint.publicKey, creator.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    if (!await connection.getAccountInfo(userAta).catch(() => null)) {
      tx.add(createAssociatedTokenAccountInstruction(creator.publicKey, userAta, creator.publicKey, mint.publicKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }

    const tradeLamportsBig = BigInt(Math.floor(Number(initialBuySol) * LAMPORTS_PER_SOL));
    const sBps = Number.isFinite(slippageBps) ? Math.max(0, Math.floor(slippageBps)) : 1000;

    const tokensOut = quoteBuyTokensOut({
      virtualTokenReserves: globalState.initialVirtualTokenReserves,
      virtualSolReserves: globalState.initialVirtualSolReserves,
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
        { pubkey: mint.publicKey, isSigner: false, isWritable: false },
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
  tx.sign(creator, mint);

  if (simulate) {
    const sim = await connection.simulateTransaction(tx, { sigVerify: true, replaceRecentBlockhash: true, commitment: 'processed' });
    if (sim.value.err) {
      const err = new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
      err.logs = sim.value.logs || [];
      throw err;
    }
    return { simulated: true, signature: null, mint: mint.publicKey.toBase58(), logs: sim.value.logs || [] };
  }

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5, preflightCommitment: 'processed' });
  await connection.confirmTransaction({ signature: sig, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight }, 'confirmed');
  return { signature: sig, mint: mint.publicKey.toBase58(), bondingCurve: bondingCurve.toBase58(), initialBuyInBlock0: Number(initialBuySol) > 0 };
}

module.exports = { deploy };
