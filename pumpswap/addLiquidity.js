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

const COPR_AMM_GLOBAL = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');

// Legacy mappings (kept for convenience), but code path now supports custom pool/lpMint overrides.
const MINT_CONFIG = {
  'CoPRYLGHc7Qadere13xSPhRvgwwStCZn9dHpBZQ7pump': {
    pool: 'AVss19ugd7SAnWTTEp8V1vHVfEqVeHXmPTUjpmsCW7di',
    lpMint: '9un2TBzBAYvbyA7oBZEc11bKFjPhefuzdYgnzmfAdTWj',
  },
  'Fofh3PEDen5jYgHcXx4vAc1hbCLNEhJpf11A8RGeXBcp': {
    pool: '8hve97TBJukyvNj5DXLVKYa3nTYD6ZUXnjKSmBNBELZH',
    lpMint: '4aSqDaD7mapXdgrJHpNepEW5Z3sNPS4FrhcV7GCazvGr',
  },
};
function u64ToBuffer(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

const DEPOSIT_DISCRIMINATOR = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);

async function addLiquidityPumpSwap({
  keyfile,
  privateKey,
  mint,
  pool: poolOverride,
  lpMint: lpMintOverride,
  globalConfig: globalConfigOverride,
  tokenAmountUi,
  solAmountUi,
  slippageBps = 50,
  lpOutMultiplier = 1,
  simulate = false,
}) {
  if (!keyfile && !privateKey) throw new Error('keyfile required (or privateKey fallback)');
  if (!mint) throw new Error('mint required');
  if (!tokenAmountUi && !solAmountUi) throw new Error('Provide at least tokenAmountUi or solAmountUi');

  const resolvedPrivateKey = keyfile ? getPrivateKeyFromFile(keyfile) : privateKey;
  const wallet = Keypair.fromSecretKey(readPrivateKey(resolvedPrivateKey));
  const mintPk = new PublicKey(mint);
  const quoteMintPk = new PublicKey('So11111111111111111111111111111111111111112');

  const mintCfg = MINT_CONFIG[mintPk.toBase58()];
  const poolStr = poolOverride || mintCfg?.pool;
  const lpMintStr = lpMintOverride || mintCfg?.lpMint;
  if (!poolStr || !lpMintStr) {
    throw new Error('Missing pool/lpMint mapping. Provide --pool and --lpMint (or add mint to MINT_CONFIG).');
  }
  const pool = new PublicKey(poolStr);
  const lpMint = new PublicKey(lpMintStr);
  const globalConfig = new PublicKey(globalConfigOverride || COPR_AMM_GLOBAL.toBase58());

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

  // Dynamic reserve-aware token quote
  const poolBaseBal = await connection.getTokenAccountBalance(poolBaseAta, 'processed');
  const poolQuoteBal = await connection.getTokenAccountBalance(poolQuoteAta, 'processed');
  const baseReserveRaw = BigInt(poolBaseBal.value.amount || '0');
  const quoteReserveRaw = BigInt(poolQuoteBal.value.amount || '0');

  const inferredTokenUi = tokenAmountUi && tokenAmountUi > 0
    ? Number(tokenAmountUi)
    : (Number(solAmountLamports) * Number(baseReserveRaw) / Number(quoteReserveRaw || 1n)) / (10 ** baseDecimals);
  const tokenAmountRaw = BigInt(Math.floor(inferredTokenUi * 10 ** baseDecimals));

  const slippageFactor = 1 + (Number(slippageBps) / 10_000);
  const maxBaseAmountIn = BigInt(Math.floor(Number(tokenAmountRaw) * slippageFactor));
  const maxQuoteAmountIn = BigInt(Math.floor(Number(solAmountLamports) * slippageFactor));

  // Dynamic LP-out target from live pool reserves and LP supply.
  const lpMintInfo = await getMint(connection, lpMint, 'processed', TOKEN_2022_PROGRAM_ID).catch(() => getMint(connection, lpMint, 'processed', TOKEN_PROGRAM_ID));
  const lpSupplyRaw = BigInt(lpMintInfo.supply.toString());
  const lpOutByQuote = (solAmountLamports * lpSupplyRaw) / (quoteReserveRaw || 1n);
  const lpOutByBase = (tokenAmountRaw * lpSupplyRaw) / (baseReserveRaw || 1n);
  const lpOutRaw = lpOutByQuote < lpOutByBase ? lpOutByQuote : lpOutByBase;
  const lpOutTarget = ((lpOutRaw * 98n) / 100n) * BigInt(Math.max(1, Number(lpOutMultiplier || 1)));

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
    pool,
    lpMint,
    globalConfig,
    tokenAmount: tokenAmountUiStr,
    solAmount: solAmountUiStr,
    slippageBps = '50',
    lpOutMultiplier = '1',
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
    pool,
    lpMint,
    globalConfig,
    tokenAmountUi: tokenAmountUiStr ? parseFloat(tokenAmountUiStr) : 0,
    solAmountUi: solAmountUiStr ? parseFloat(solAmountUiStr) : 0,
    slippageBps: parseInt(slippageBps, 10),
    lpOutMultiplier: parseInt(lpOutMultiplier, 10),
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