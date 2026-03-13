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
const { buy } = require('../pump/buy');

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

async function resolvePoolFromDexscreener(mint, preferredDex = 'pumpswap') {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dexscreener token lookup failed: ${res.status}`);
  const data = await res.json();
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  if (!pairs.length) throw new Error(`No pools found on Dexscreener for mint ${mint}`);

  const normalized = pairs
    .filter((p) => p?.chainId === 'solana' && p?.pairAddress)
    .map((p) => ({
      dexId: String(p.dexId || '').toLowerCase(),
      pairAddress: p.pairAddress,
      liquidityUsd: Number(p?.liquidity?.usd || 0),
      quote: p?.quoteToken?.address || '',
    }));

  const preferred = normalized.filter((p) => p.dexId === preferredDex);
  const pickFrom = preferred.length ? preferred : normalized;
  pickFrom.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return pickFrom[0];
}

async function deriveLpMintFromPool(poolPk, baseMintPk, quoteMintPk) {
  const poolAcc = await connection.getAccountInfo(poolPk, 'processed');
  if (!poolAcc) throw new Error(`Pool account not found: ${poolPk.toBase58()}`);

  const data = poolAcc.data;
  const seen = new Set();
  const candidates = [];
  for (let i = 0; i + 32 <= data.length; i++) {
    try {
      const s = new PublicKey(data.slice(i, i + 32)).toBase58();
      if (seen.has(s)) continue;
      seen.add(s);
      candidates.push(new PublicKey(s));
    } catch {}
  }

  for (let i = 0; i < candidates.length; i += 100) {
    const chunk = candidates.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk, 'processed');
    for (let j = 0; j < chunk.length; j++) {
      const pk = chunk[j];
      const ai = infos[j];
      if (!ai) continue;
      const ownerIsToken = ai.owner.equals(TOKEN_PROGRAM_ID) || ai.owner.equals(TOKEN_2022_PROGRAM_ID);
      if (!ownerIsToken) continue;
      if (ai.data.length !== 82) continue; // mint account
      if (pk.equals(baseMintPk) || pk.equals(quoteMintPk)) continue;
      return pk.toBase58();
    }
  }

  throw new Error(`Could not derive lp mint from pool ${poolPk.toBase58()}`);
}

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
  let poolStr = poolOverride || mintCfg?.pool;
  let lpMintStr = lpMintOverride || mintCfg?.lpMint;

  if (!poolStr) {
    const resolved = await resolvePoolFromDexscreener(mintPk.toBase58(), 'pumpswap');
    poolStr = resolved.pairAddress;
  }

  const pool = new PublicKey(poolStr);
  if (!lpMintStr) {
    lpMintStr = await deriveLpMintFromPool(pool, mintPk, quoteMintPk);
  }

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
  let tokenAmountRaw = BigInt(Math.floor(inferredTokenUi * 10 ** baseDecimals));

  // Cap token side to actual wallet balance to avoid insufficient-funds failures on dynamic estimate.
  const userBaseBal = await connection.getTokenAccountBalance(userBaseAta, 'processed').catch(() => null);
  const userBaseRaw = BigInt(userBaseBal?.value?.amount || '0');
  if (tokenAmountRaw > userBaseRaw) tokenAmountRaw = userBaseRaw;

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

async function getTokenBalanceRaw({ owner, mint, tokenProgramId = TOKEN_2022_PROGRAM_ID }) {
  const ata = await getAssociatedTokenAddress(mint, owner, false, tokenProgramId);
  const info = await connection.getAccountInfo(ata, 'processed');
  if (!info) return 0n;
  const bal = await connection.getTokenAccountBalance(ata, 'processed');
  return BigInt(bal?.value?.amount || '0');
}

async function autoBuyThenAddLiquidity({
  keyfile,
  privateKey,
  mint,
  pool,
  lpMint,
  globalConfig,
  depositSol,
  slippageBps = 50,
  buySlippageBps,
  lpOutMultiplier = 1,
  simulate = false,
}) {
  if (!Number.isFinite(depositSol) || depositSol <= 0) {
    throw new Error('--depositSol must be a positive number');
  }
  if (simulate) {
    throw new Error('--simulate is not supported with --depositSol (it includes a real buy step).');
  }

  const resolvedPrivateKey = keyfile ? getPrivateKeyFromFile(keyfile) : privateKey;
  const wallet = Keypair.fromSecretKey(readPrivateKey(resolvedPrivateKey));
  const mintPk = new PublicKey(mint);

  const buySol = depositSol / 2;
  const lpSol = depositSol - buySol;

  let baseMintInfo;
  let tokenProgramId = TOKEN_2022_PROGRAM_ID;
  try {
    baseMintInfo = await getMint(connection, mintPk, 'processed', TOKEN_2022_PROGRAM_ID);
  } catch (_) {
    tokenProgramId = TOKEN_PROGRAM_ID;
    baseMintInfo = await getMint(connection, mintPk, 'processed', TOKEN_PROGRAM_ID);
  }

  const beforeRaw = await getTokenBalanceRaw({ owner: wallet.publicKey, mint: mintPk, tokenProgramId });

  const buyRes = await buy({
    privateKey: resolvedPrivateKey,
    mint,
    sol: buySol,
    slippageBps: Number.isFinite(Number(buySlippageBps)) ? Number(buySlippageBps) : Number(slippageBps),
  });

  const afterRaw = await getTokenBalanceRaw({ owner: wallet.publicKey, mint: mintPk, tokenProgramId });
  const boughtRaw = afterRaw - beforeRaw;
  if (boughtRaw <= 0n) {
    throw new Error('Auto-buy completed but token delta was 0. Aborting add-liquidity.');
  }

  const tokenAmountUi = Number(boughtRaw) / (10 ** baseMintInfo.decimals);
  if (!Number.isFinite(tokenAmountUi) || tokenAmountUi <= 0) {
    throw new Error('Failed to derive tokenAmountUi from buy result.');
  }

  const addRes = await addLiquidityPumpSwap({
    privateKey: resolvedPrivateKey,
    mint,
    pool,
    lpMint,
    globalConfig,
    tokenAmountUi,
    solAmountUi: lpSol,
    slippageBps,
    lpOutMultiplier,
    simulate: false,
  });

  return {
    mode: 'autoBuyThenAddLiquidity',
    depositSol,
    split: { buySol, lpSol },
    tokenBoughtRaw: boughtRaw.toString(),
    tokenAmountUi,
    buy: buyRes,
    addLiquidity: addRes,
  };
}

async function addAllTokenBalanceOneShot({
  keyfile,
  privateKey,
  mint,
  pool,
  lpMint,
  globalConfig,
  slippageBps = 50,
  lpOutMultiplier = 1,
  solBufferUi = 0.0005,
  simulate = false,
}) {
  if (!keyfile && !privateKey) throw new Error('keyfile required (or privateKey fallback)');
  if (!mint) throw new Error('mint required');

  const resolvedPrivateKey = keyfile ? getPrivateKeyFromFile(keyfile) : privateKey;
  const wallet = Keypair.fromSecretKey(readPrivateKey(resolvedPrivateKey));
  const mintPk = new PublicKey(mint);

  const mintCfg = MINT_CONFIG[mintPk.toBase58()];
  let poolStr = pool || mintCfg?.pool;
  let lpMintStr = lpMint || mintCfg?.lpMint;
  if (!poolStr) {
    const resolved = await resolvePoolFromDexscreener(mintPk.toBase58(), 'pumpswap');
    poolStr = resolved.pairAddress;
  }

  const quoteMintPk = new PublicKey('So11111111111111111111111111111111111111112');
  const poolPk = new PublicKey(poolStr);
  if (!lpMintStr) {
    lpMintStr = await deriveLpMintFromPool(poolPk, mintPk, quoteMintPk);
  }

  let tokenProgramId = TOKEN_2022_PROGRAM_ID;
  let baseMintInfo;
  try {
    baseMintInfo = await getMint(connection, mintPk, 'processed', TOKEN_2022_PROGRAM_ID);
  } catch (_) {
    tokenProgramId = TOKEN_PROGRAM_ID;
    baseMintInfo = await getMint(connection, mintPk, 'processed', TOKEN_PROGRAM_ID);
  }

  const userBaseAta = await getAssociatedTokenAddress(mintPk, wallet.publicKey, false, tokenProgramId);
  const poolBaseAta = await getAssociatedTokenAddress(mintPk, poolPk, true, tokenProgramId);
  const poolQuoteAta = await getAssociatedTokenAddress(quoteMintPk, poolPk, true, TOKEN_PROGRAM_ID);

  const userBaseBal = await connection.getTokenAccountBalance(userBaseAta, 'processed').catch(() => null);
  const userTokenRaw = BigInt(userBaseBal?.value?.amount || '0');
  if (userTokenRaw <= 0n) throw new Error('No token balance available for one-shot LP');

  const poolBaseBal = await connection.getTokenAccountBalance(poolBaseAta, 'processed');
  const poolQuoteBal = await connection.getTokenAccountBalance(poolQuoteAta, 'processed');
  const baseReserveRaw = BigInt(poolBaseBal.value.amount || '0');
  const quoteReserveRaw = BigInt(poolQuoteBal.value.amount || '0');
  if (baseReserveRaw <= 0n || quoteReserveRaw <= 0n) throw new Error('Pool reserves unavailable/zero');

  const requiredQuoteRaw = (userTokenRaw * quoteReserveRaw) / baseReserveRaw;
  const requiredSolUi = Number(requiredQuoteRaw) / LAMPORTS_PER_SOL;
  if (!Number.isFinite(requiredSolUi) || requiredSolUi <= 0) throw new Error('Failed to derive required SOL from pool ratio');

  const walletSolUi = (await connection.getBalance(wallet.publicKey, 'processed')) / LAMPORTS_PER_SOL;
  const neededWithBuffer = requiredSolUi + Number(solBufferUi || 0);
  if (walletSolUi < neededWithBuffer) {
    return {
      mode: 'oneShotAllToken',
      mint: mintPk.toBase58(),
      tokenAmountRaw: userTokenRaw.toString(),
      tokenAmountUi: Number(userTokenRaw) / (10 ** baseMintInfo.decimals),
      requiredSolUi,
      solBufferUi: Number(solBufferUi || 0),
      requiredSolWithBufferUi: neededWithBuffer,
      walletSolUi,
      shortBySolUi: neededWithBuffer - walletSolUi,
      status: 'insufficient_sol',
    };
  }

  const res = await addLiquidityPumpSwap({
    privateKey: resolvedPrivateKey,
    mint,
    pool: poolStr,
    lpMint: lpMintStr,
    globalConfig,
    tokenAmountUi: Number(userTokenRaw) / (10 ** baseMintInfo.decimals),
    solAmountUi: requiredSolUi,
    slippageBps,
    lpOutMultiplier,
    simulate,
  });

  return {
    mode: 'oneShotAllToken',
    mint: mintPk.toBase58(),
    tokenAmountRaw: userTokenRaw.toString(),
    tokenAmountUi: Number(userTokenRaw) / (10 ** baseMintInfo.decimals),
    requiredSolUi,
    walletSolUi,
    status: 'ok',
    addLiquidity: res,
  };
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
    depositSol: depositSolStr,
    slippageBps = '50',
    buySlippageBps,
    lpOutMultiplier = '1',
    simulate = 'false',
  } = params;

  if (!mint || (!depositSolStr && !tokenAmountUiStr && !solAmountUiStr)) {
    console.error('Usage: node addLiquidity.js --mint <CA> (--depositSol <SOL_TOTAL> | --tokenAmount <UI_AMOUNT> --solAmount <SOL_UI>) [--slippageBps 50] [--buySlippageBps 500] [--simulate true] [--keyfile <WALLET_JSON>]');
    console.error('Example (auto split): node addLiquidity.js --mint CoPRYLGHc7Qadere13xSPhRvgwwStCZn9dHpBZQ7pump --depositSol 0.6 --keyfile ./wallets/main.json');
    process.exit(1);
  }

  const resolvedPrivateKey = params.keyfile
    ? getPrivateKeyFromFile(params.keyfile)
    : (process.env.PRIVATE_KEY || params.privateKey);

  const runner = depositSolStr
    ? autoBuyThenAddLiquidity({
        privateKey: resolvedPrivateKey,
        mint,
        pool,
        lpMint,
        globalConfig,
        depositSol: parseFloat(depositSolStr),
        slippageBps: parseInt(slippageBps, 10),
        buySlippageBps: buySlippageBps ? parseInt(buySlippageBps, 10) : undefined,
        lpOutMultiplier: parseInt(lpOutMultiplier, 10),
        simulate: simulate === 'true',
      })
    : addLiquidityPumpSwap({
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
      });

  runner
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => {
      console.error('Error:', err.message);
      if (err.logs) console.error('Logs:\n', err.logs.join('\n'));
      process.exit(1);
    });
}

module.exports = { addLiquidityPumpSwap, autoBuyThenAddLiquidity, addAllTokenBalanceOneShot };