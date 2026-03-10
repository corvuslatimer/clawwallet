const axios = require('axios');
const {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} = require('@solana/web3.js');
const { getAssociatedTokenAddress, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { anchorDisc } = require('../utils/encoding');
const { readPrivateKey } = require('../utils/wallet');
const { connection } = require('../solana/connection');
const { sendTx, computeUnitPriceMicrolamports } = require('../solana/tx');
const { PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID } = require('../config/constants');
const {
  PUMP_GLOBAL,
  PUMP_EVENT_AUTHORITY,
  PUMP_GLOBAL_VOLUME_ACCUMULATOR,
  PUMP_FEE_CONFIG,
  creatorVaultPda,
  userVolumeAccumulatorPda,
} = require('../solana/pda');
const {
  tokenProgramForMint,
  getBondingCurveState,
  fetchPumpGlobalState,
  resolvePumpFeeRecipientForMint,
  quoteSellSolOut,
} = require('./common');

function encodeOptionBool(v) {
  if (v === null || v === undefined) return Buffer.from([0]);
  return Buffer.from([1, v ? 1 : 0]);
}

async function sell({ privateKey, mint, amount, slippageBps = 500 }) {
  const { Keypair } = require('@solana/web3.js');
  const user = Keypair.fromSecretKey(readPrivateKey(privateKey));
  const mintPk = new PublicKey(mint);
  const tokenProgramId = await tokenProgramForMint(mintPk);

  const userAta = await getAssociatedTokenAddress(mintPk, user.publicKey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

  const bal = await connection.getTokenAccountBalance(userAta).catch(() => null);
  const decimals = bal?.value?.decimals ?? 6;
  const amountRaw = BigInt(Math.floor(Number(amount) * 10 ** decimals));
  if (amountRaw <= 0n) throw new Error('Amount must be > 0');

  const curve = await getBondingCurveState(mintPk, tokenProgramId);
  if (!curve) throw new Error('Bonding curve not found');

  if (!curve.complete) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(300_000) })
    );

    const globalState = await fetchPumpGlobalState();
    const feeRecipientPk = resolvePumpFeeRecipientForMint({ mintPk, bondingCurveState: curve, globalState });

    const bcAta = await getAssociatedTokenAddress(mintPk, curve.bondingCurve, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

    const sBps = Number.isFinite(slippageBps) ? Math.max(0, Math.floor(slippageBps)) : 500;

    const solOutUser = quoteSellSolOut({
      virtualTokenReserves: curve.virtualTokenReserves,
      virtualSolReserves: curve.virtualSolReserves,
      tokensIn: amountRaw,
      protocolFeeBps: globalState.protocolFeeBps,
      creatorFeeBps: globalState.creatorFeeBps,
    });

    if (solOutUser <= 0n) throw new Error('Quote returned 0 SOL out; decrease amount or check liquidity');

    const minSolOut = solOutUser - (solOutUser * BigInt(sBps)) / 10_000n;

    const data = Buffer.concat([anchorDisc('sell'), Buffer.alloc(8), Buffer.alloc(8), encodeOptionBool(true)]);
    data.writeBigUInt64LE(amountRaw, 8);
    data.writeBigUInt64LE(minSolOut, 16);

    tx.add(new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: feeRecipientPk, isSigner: false, isWritable: true },
        { pubkey: mintPk, isSigner: false, isWritable: false },
        { pubkey: curve.bondingCurve, isSigner: false, isWritable: true },
        { pubkey: bcAta, isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false },
        { pubkey: creatorVaultPda(curve.creator), isSigner: false, isWritable: true },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PUMP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },
        { pubkey: userVolumeAccumulatorPda(user.publicKey), isSigner: false, isWritable: true },
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    }));

    tx.feePayer = user.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(user);

    let sig;
    try {
      sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    } catch (e) {
      if (e?.message?.includes('blockheight exceeded')) {
        const { blockhash: bh2, lastValidBlockHeight: lvbh2 } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = bh2;
        tx.sign(user);
        sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
        return { signature: sig, amountRaw: amountRaw.toString(), blockhash: bh2, lastValidBlockHeight: lvbh2 };
      }
      throw e;
    }

    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return { signature: sig, amountRaw: amountRaw.toString() };
  }

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const instructionCollector = new Transaction();

  const quoteUrl = `https://public.jupiterapi.com/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${amountRaw.toString()}&slippageBps=${slippageBps}&onlyDirectRoutes=false&platformFeeBps=0`;

  let quoteResponse;
  try {
    const quoteRes = await axios.get(quoteUrl);
    quoteResponse = quoteRes.data;
  } catch (err) {
    throw new Error(`Jupiter quote failed: ${err.response?.status || ''} - ${err.response?.data?.error || err.message}`);
  }

  if (!quoteResponse || !quoteResponse.outAmount) throw new Error('Invalid quote from Jupiter');
  if (quoteResponse.platformFee) delete quoteResponse.platformFee;

  let swapInstructionsData;
  try {
    const res = await axios.post('https://public.jupiterapi.com/swap-instructions', {
      quoteResponse,
      userPublicKey: user.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: computeUnitPriceMicrolamports(600_000),
      useSharedAccounts: false,
    }, { headers: { 'Content-Type': 'application/json' } });
    swapInstructionsData = res.data;
  } catch (err) {
    throw new Error(`Jupiter swap-instructions failed: ${err.response?.status || ''} - ${err.response?.data?.error || err.message}`);
  }

  const jupiterInstructions = [];
  for (const instr of (swapInstructionsData.setupInstructions || [])) {
    jupiterInstructions.push(new TransactionInstruction({
      programId: new PublicKey(instr.programId),
      keys: instr.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: Buffer.from(instr.data, 'base64'),
    }));
  }

  if (swapInstructionsData.swapInstruction) {
    const instr = swapInstructionsData.swapInstruction;
    jupiterInstructions.push(new TransactionInstruction({
      programId: new PublicKey(instr.programId),
      keys: instr.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: Buffer.from(instr.data, 'base64'),
    }));
  }

  if (swapInstructionsData.cleanupInstruction) {
    const instr = swapInstructionsData.cleanupInstruction;
    jupiterInstructions.push(new TransactionInstruction({
      programId: new PublicKey(instr.programId),
      keys: instr.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: Buffer.from(instr.data, 'base64'),
    }));
  }

  instructionCollector.add(...jupiterInstructions);

  const lookupTables = (swapInstructionsData.addressLookupTableAccounts || []).map((alt) => ({
    key: new PublicKey(alt.key),
    writableIndexes: alt.writableIndexes || [],
    readonlyIndexes: alt.readonlyIndexes || [],
  }));

  const messageV0 = new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: blockhash, instructions: instructionCollector.instructions }).compileToV0Message(lookupTables);
  const versionedTx = new VersionedTransaction(messageV0);
  versionedTx.sign([user]);

  const sig = await sendTx(versionedTx, [user]);
  return { signature: sig, amountRaw: amountRaw.toString() };
}

module.exports = { sell };
