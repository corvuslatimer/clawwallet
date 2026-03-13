const axios = require('axios');
const {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
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
  quoteBuyTokensOut,
} = require('./common');

async function pumpBuyToken({ privateKey, mint, sol, slippageBps = 500 }) {
  const { Keypair } = require('@solana/web3.js');
  const user = Keypair.fromSecretKey(readPrivateKey(privateKey));
  const mintPk = new PublicKey(mint);
  const lamportsIn = Math.floor(Number(sol) * LAMPORTS_PER_SOL);
  if (lamportsIn <= 0) throw new Error('sol must be > 0');

  const tokenProgramId = await tokenProgramForMint(mintPk);
  const curve = await getBondingCurveState(mintPk, tokenProgramId);
  if (!curve) throw new Error('Bonding curve not found');

  // Active bonding curve => native pump buy
  if (!curve.complete) {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(300_000) })
    );

    const globalState = await fetchPumpGlobalState();
    const feeRecipientPk = resolvePumpFeeRecipientForMint({ mintPk, bondingCurveState: curve, globalState });

    const userAta = await getAssociatedTokenAddress(mintPk, user.publicKey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
    const bcAta = await getAssociatedTokenAddress(mintPk, curve.bondingCurve, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

    if (!await connection.getAccountInfo(userAta)) {
      tx.add(createAssociatedTokenAccountInstruction(user.publicKey, userAta, user.publicKey, mintPk, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID));
    }

    const tradeLamportsBig = BigInt(lamportsIn);
    const tokensOut = quoteBuyTokensOut({
      virtualTokenReserves: curve.virtualTokenReserves,
      virtualSolReserves: curve.virtualSolReserves,
      spendableSolIn: tradeLamportsBig,
      protocolFeeBps: globalState.protocolFeeBps,
      creatorFeeBps: globalState.creatorFeeBps,
    });
    if (tokensOut <= 0n) throw new Error('Quote returned 0 tokensOut');

    const maxSolCost = tradeLamportsBig + (tradeLamportsBig * BigInt(slippageBps)) / 10_000n;

    // buy layout: discriminator(8) + amount(u64) + max_sol_cost(u64) + track_volume(bool-ish)
    const data = Buffer.alloc(8 + 8 + 8 + 1);
    anchorDisc('buy').copy(data, 0);
    data.writeBigUInt64LE(tokensOut, 8);
    data.writeBigUInt64LE(maxSolCost, 16);
    data.writeUInt8(1, 24);

    const bondingCurveV2 = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve-v2'), mintPk.toBuffer()],
      PUMP_PROGRAM_ID
    )[0];

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
        { pubkey: bondingCurveV2, isSigner: false, isWritable: false },
      ],
      data,
    }));

    const sig = await sendTx(tx, [user]);
    return { signature: sig, tradeLamports: lamportsIn, tokensOut: tokensOut.toString(), route: 'pump' };
  }

  // Completed/bonded => Jupiter route
  const tradeLamports = lamportsIn;
  const inputMint = 'So11111111111111111111111111111111111111112';
  const outputMint = mint;

  const quoteUrl = `https://public.jupiterapi.com/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${tradeLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;

  let quoteResponse;
  try {
    const quoteRes = await axios.get(quoteUrl);
    quoteResponse = quoteRes.data;
  } catch (err) {
    throw new Error(`Jupiter quote failed: ${err.response?.status || ''} - ${err.response?.data?.error || err.message}`);
  }

  if (!quoteResponse || !quoteResponse.outAmount) {
    throw new Error('Invalid quote from Jupiter');
  }

  const body = {
    quoteResponse,
    userPublicKey: user.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    computeUnitPriceMicroLamports: computeUnitPriceMicrolamports(600_000),
    useSharedAccounts: true,
  };

  let swapInstructionsData;
  try {
    const res = await axios.post('https://public.jupiterapi.com/swap-instructions', body, {
      headers: { 'Content-Type': 'application/json' },
    });
    swapInstructionsData = res.data;
  } catch (err) {
    throw new Error(`Jupiter swap-instructions failed: ${err.response?.status || ''} - ${err.response?.data?.error || err.message}`);
  }

  const instructionCollector = new Transaction();
  const jupiterInstructions = [];

  if (swapInstructionsData.setupInstructions) {
    swapInstructionsData.setupInstructions.forEach((instr) => {
      jupiterInstructions.push(new TransactionInstruction({
        programId: new PublicKey(instr.programId),
        keys: instr.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
        data: Buffer.from(instr.data, 'base64'),
      }));
    });
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

  let lookupTables = [];
  if (swapInstructionsData.addressLookupTableAccounts) {
    lookupTables = swapInstructionsData.addressLookupTableAccounts.map((alt) => ({
      key: new PublicKey(alt.key),
      writableIndexes: alt.writableIndexes || [],
      readonlyIndexes: alt.readonlyIndexes || [],
    }));
  }

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const messageV0 = new TransactionMessage({
    payerKey: user.publicKey,
    recentBlockhash: blockhash,
    instructions: instructionCollector.instructions,
  }).compileToV0Message(lookupTables);

  const versionedTx = new VersionedTransaction(messageV0);
  versionedTx.sign([user]);

  const sig = await sendTx(versionedTx, [user]);
  return { signature: sig, tradeLamports, route: 'jupiter' };
}

async function buy({ privateKey, mint, sol, slippageBps = 500 }) {
  return pumpBuyToken({ privateKey, mint, sol, slippageBps });
}

module.exports = { buy, pumpBuyToken };
