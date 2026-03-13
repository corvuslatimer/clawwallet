const axios = require('axios');
const {
  PublicKey,

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
  PUMP_FEE_CONFIG,
  creatorVaultPda,
} = require('../solana/pda');
const {
  tokenProgramForMint,
  getBondingCurveState,
  fetchPumpGlobalState,
  resolvePumpFeeRecipientForMint,
  quoteSellSolOut,
} = require('./common');

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

  // Active bonding curve => native pump sell
  if (!curve.complete) {
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(300_000) }),
    ];

    const globalState = await fetchPumpGlobalState();
    const feeRecipientPk = resolvePumpFeeRecipientForMint({ mintPk, bondingCurveState: curve, globalState });

    const bcAta = await getAssociatedTokenAddress(mintPk, curve.bondingCurve, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

    const netSolOut = quoteSellSolOut({
      virtualTokenReserves: curve.virtualTokenReserves,
      virtualSolReserves: curve.virtualSolReserves,
      tokensIn: amountRaw,
      protocolFeeBps: globalState.protocolFeeBps,
      creatorFeeBps: globalState.creatorFeeBps,
    });
    if (netSolOut <= 0n) throw new Error('Quote returned 0 solOut');

    const minSolOut = (netSolOut * (10000n - BigInt(slippageBps))) / 10000n;

    const data = Buffer.concat([anchorDisc('sell'), Buffer.alloc(8), Buffer.alloc(8)]);
    data.writeBigUInt64LE(amountRaw, 8);
    data.writeBigUInt64LE(minSolOut, 16);

    const bondingCurveV2 = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve-v2'), mintPk.toBuffer()],
      PUMP_PROGRAM_ID
    )[0];

    instructions.push(new TransactionInstruction({
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
        { pubkey: creatorVaultPda(curve.creator), isSigner: false, isWritable: true },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: bondingCurveV2, isSigner: false, isWritable: false },
      ],
      data,
    }));

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: user.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign([user]);

    const sig = await sendTx(versionedTx, [user]);
    return { signature: sig, amountRaw: amountRaw.toString(), route: 'pump' };
  }

  // Completed/bonded => Jupiter route
  const quoteUrl = `https://public.jupiterapi.com/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${amountRaw.toString()}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;

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
    instructions: jupiterInstructions,
  }).compileToV0Message(lookupTables);

  const versionedTx = new VersionedTransaction(messageV0);
  versionedTx.sign([user]);

  const sig = await sendTx(versionedTx, [user]);
  return { signature: sig, amountRaw: amountRaw.toString(), route: 'jupiter' };
}

module.exports = { sell };
