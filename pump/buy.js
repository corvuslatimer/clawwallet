const { PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { anchorDisc } = require('../utils/encoding');
const { readPrivateKey } = require('../utils/wallet');
const { connection } = require('../solana/connection');
const { sendTx, computeUnitPriceMicrolamports } = require('../solana/tx');
const { PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID } = require('../config/constants');
const { PUMP_GLOBAL, PUMP_EVENT_AUTHORITY, PUMP_GLOBAL_VOLUME_ACCUMULATOR, PUMP_FEE_CONFIG, creatorVaultPda, userVolumeAccumulatorPda } = require('../solana/pda');
const { tokenProgramForMint, getBondingCurveState, fetchPumpGlobalState, resolvePumpFeeRecipientForMint, quoteBuyTokensOut } = require('./common');

async function pumpBuyToken({ privateKey, mint, sol, slippageBps = 1000 }) {
  const { Keypair } = require('@solana/web3.js');
  const user = Keypair.fromSecretKey(readPrivateKey(privateKey));
  const mintPk = new PublicKey(mint);
  const tokenProgramId = await tokenProgramForMint(mintPk);
  const curve = await getBondingCurveState(mintPk, tokenProgramId);
  if (!curve || curve.complete) throw new Error('Bonding curve unavailable or completed');

  const lamportsIn = Math.floor(Number(sol) * LAMPORTS_PER_SOL);
  const tradeLamportsBig = BigInt(lamportsIn);
  const globalState = await fetchPumpGlobalState();
  const feeRecipientPk = resolvePumpFeeRecipientForMint({ mintPk, bondingCurveState: curve, globalState });

  const userAta = await getAssociatedTokenAddress(mintPk, user.publicKey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
  const bcAta = await getAssociatedTokenAddress(mintPk, curve.bondingCurve, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(300000) })
  );
  if (!await connection.getAccountInfo(userAta)) {
    tx.add(createAssociatedTokenAccountInstruction(user.publicKey, userAta, user.publicKey, mintPk, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID));
  }

  const tokensOut = quoteBuyTokensOut({
    virtualTokenReserves: curve.virtualTokenReserves,
    virtualSolReserves: curve.virtualSolReserves,
    spendableSolIn: tradeLamportsBig,
    protocolFeeBps: globalState.protocolFeeBps,
    creatorFeeBps: globalState.creatorFeeBps,
  });
  const maxSolCost = tradeLamportsBig + (tradeLamportsBig * BigInt(slippageBps)) / 10000n;
  const data = Buffer.concat([anchorDisc('buy'), Buffer.alloc(8), Buffer.alloc(8), Buffer.from([1,1])]);
  data.writeBigUInt64LE(tokensOut, 8);
  data.writeBigUInt64LE(maxSolCost, 16);

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

  const sig = await sendTx(tx, [user]);
  return { signature: sig, tradeLamports: lamportsIn, tokensOut: tokensOut.toString(), route: 'pump' };
}

async function buy({ privateKey, mint, sol, slippageBps = 500 }) {
  const { buyToken: buyTokenJupiterSafe } = require('../readme');
  try {
    const result = await buyTokenJupiterSafe({ privateKey, mint, sol: String(sol), slippageBps });
    return { signature: result.signature, tradeLamports: Math.floor(Number(sol) * LAMPORTS_PER_SOL), route: 'jupiter', meta: result };
  } catch {
    return pumpBuyToken({ privateKey, mint, sol, slippageBps: Math.max(1000, slippageBps) });
  }
}

module.exports = { buy, pumpBuyToken };
