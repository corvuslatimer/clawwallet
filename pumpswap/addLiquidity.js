// pumpswap/addLiquidity.js

const {
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getMint,
} = require('@solana/spl-token');
const { readPrivateKey, getPrivateKeyFromFile } = require('../utils/wallet');
const { connection } = require('../solana/connection');
const { computeUnitPriceMicrolamports } = require('../solana/tx');
const { PUMP_SWAP_PROGRAM_ID } = require('../config/constants'); // pAMMB...

const COPR_MINT = new PublicKey('CoPRYLGHc7Qadere13xSPhRvgwwStCZn9dHpBZQ7pump');
const COPR_POOL = new PublicKey('AVss19ugd7SAnWTTEp8V1vHVfEqVeHXmPTUjpmsCW7di');
const COPR_AMM_GLOBAL = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const COPR_LP_MINT = new PublicKey('9un2TBzBAYvbyA7oBZEc11bKFjPhefuzdYgnzmfAdTWj');
function u64ToBuffer(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

const DEPOSIT_DISCRIMINATOR = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);

async function addLiquidityPumpSwap({
  privateKey,
  mint,
  tokenAmountUi,
  solAmountUi,
  slippageBps = 50,
  simulate = false,
}) {
  if (!privateKey) throw new Error('privateKey required (use env PRIVATE_KEY or pass it)');
  if (!mint) throw new Error('mint required');
  if (!tokenAmountUi && !solAmountUi) throw new Error('Provide at least tokenAmountUi or solAmountUi');

  const wallet = Keypair.fromSecretKey(readPrivateKey(privateKey));
  const mintPk = new PublicKey(mint);
  const quoteMintPk = new PublicKey('So11111111111111111111111111111111111111112');

  if (!mintPk.equals(COPR_MINT)) {
    throw new Error('This draft currently supports only CoPR... mint. Provide pool/global/lp mapping for other mints.');
  }

  const pool = COPR_POOL;
  const lpMint = COPR_LP_MINT;
  const globalConfig = COPR_AMM_GLOBAL;
  const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_SWAP_PROGRAM_ID)[0];

  const userBaseAta = await getAssociatedTokenAddress(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const userQuoteAta = await getAssociatedTokenAddress(quoteMintPk, wallet.publicKey, false, TOKEN_PROGRAM_ID);
  const userLpAta = await getAssociatedTokenAddress(lpMint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const poolBaseAta = await getAssociatedTokenAddress(mintPk, pool, true, TOKEN_2022_PROGRAM_ID);
  const poolQuoteAta = await getAssociatedTokenAddress(quoteMintPk, pool, true, TOKEN_PROGRAM_ID);

  let baseMintInfo;
  try {
    baseMintInfo = await getMint(connection, mintPk, 'processed', TOKEN_2022_PROGRAM_ID);
  } catch (_) {
    baseMintInfo = await getMint(connection, mintPk, 'processed', TOKEN_PROGRAM_ID);
  }
  const baseDecimals = baseMintInfo.decimals;

  const solAmountLamports = BigInt(Math.floor((solAmountUi || 0) * LAMPORTS_PER_SOL));

  // Ratio calibrated from known successful deposit tx:
  // 0.1 SOL ↔ 22,772.475945 token and 1.287174982 LP minted.
  const inferredTokenUi = tokenAmountUi && tokenAmountUi > 0
    ? tokenAmountUi
    : (Number(solAmountUi) * 22772.475945 / 0.1);
  const tokenAmountRaw = BigInt(Math.floor(inferredTokenUi * 10 ** baseDecimals));

  const slippageFactor = 1 + (Number(slippageBps) / 10_000);
  const maxBaseAmountIn = BigInt(Math.floor(Number(tokenAmountRaw) * slippageFactor));
  const maxQuoteAmountIn = BigInt(Math.floor(Number(solAmountLamports) * slippageFactor));

  // Conservative LP out target for 0.05 SOL test (scales from reference tx)
  const lpOutTarget = BigInt(Math.floor(Number(solAmountUi) * (1287174982 / 0.1) * 0.98));

  const data = Buffer.concat([
    DEPOSIT_DISCRIMINATOR,
    u64ToBuffer(lpOutTarget),
    u64ToBuffer(maxBaseAmountIn),
    u64ToBuffer(maxQuoteAmountIn),
  ]);

  const accounts = [
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: globalConfig, isSigner: false, isWritable: false },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: false },
    { pubkey: quoteMintPk, isSigner: false, isWritable: false },
    { pubkey: lpMint, isSigner: false, isWritable: true },
    { pubkey: userBaseAta, isSigner: false, isWritable: true },
    { pubkey: userQuoteAta, isSigner: false, isWritable: true },
    { pubkey: userLpAta, isSigner: false, isWritable: true },
    { pubkey: poolBaseAta, isSigner: false, isWritable: true },
    { pubkey: poolQuoteAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMP_SWAP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const depositIx = new TransactionInstruction({
    programId: PUMP_SWAP_PROGRAM_ID,
    keys: accounts,
    data,
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(600_000) }),
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userQuoteAta, wallet.publicKey, quoteMintPk, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userLpAta, wallet.publicKey, lpMint, TOKEN_2022_PROGRAM_ID),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: userQuoteAta,
      lamports: solAmountLamports,
    }),
    createSyncNativeInstruction(userQuoteAta),
    depositIx,
    createCloseAccountInstruction(userQuoteAta, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID)
  );

  tx.feePayer = wallet.publicKey;
  const latestBlockhash = await connection.getLatestBlockhash('processed');
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.sign(wallet);

  if (simulate) {
    const sim = await connection.simulateTransaction(tx, [wallet], { commitment: 'processed' });
    if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}\nLogs:\n${sim.value.logs?.join('\n') || 'No logs'}`);
    return { simulated: true, logs: sim.value.logs || [] };
  }

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 5,
    preflightCommitment: 'processed',
  });
  await connection.confirmTransaction({ signature: sig, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight }, 'confirmed');

  return { signature: sig };
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < args.length; i += 2) {
    let key = args[i].replace(/^--/, '');
    key = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); // normalize --token-amount → tokenAmount
    const value = args[i + 1];
    params[key] = value;
  }

  const {
    mint,
    tokenAmount: tokenAmountUiStr,
    solAmount: solAmountUiStr,
    slippageBps = '50',
    simulate = 'false',
  } = params;

  if (!mint || (!tokenAmountUiStr && !solAmountUiStr)) {
    console.error('Usage: node addLiquidity.js --mint <CA> --tokenAmount <UI_AMOUNT> --solAmount <SOL_UI> [--slippageBps 50] [--simulate true] [--keyfile <WALLET_JSON>]');
    console.error('Example: node addLiquidity.js --mint CoPRYLGHc7Qadere13xSPhRvgwwStCZn9dHpBZQ7pump --solAmount 0.1 --simulate true --keyfile ./wallets/main.json');
    process.exit(1);
  }

  const resolvedPrivateKey = params.keyfile
    ? getPrivateKeyFromFile(params.keyfile)
    : (process.env.PRIVATE_KEY || params.privateKey);

  addLiquidityPumpSwap({
    privateKey: resolvedPrivateKey,
    mint,
    tokenAmountUi: tokenAmountUiStr ? parseFloat(tokenAmountUiStr) : 0,
    solAmountUi: solAmountUiStr ? parseFloat(solAmountUiStr) : 0,
    slippageBps: parseInt(slippageBps, 10),
    simulate: simulate === 'true',
  })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => {
      console.error('Error:', err.message);
      if (err.logs) console.error('Logs:\n', err.logs.join('\n'));
      process.exit(1);
    });
}

module.exports = { addLiquidityPumpSwap };