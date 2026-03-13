// pumpswap/removeLiquidity.js

const {
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  PublicKey,
  Keypair,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
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

// Discriminator for Withdraw (from known PumpSwap patterns; verify via explorer if needed)
const WITHDRAW_DISCRIMINATOR = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);

async function removeLiquidityPumpSwap({
  privateKey,
  mint,
  lpAmountUi,
  slippageBps = 50,
  simulate = false,
}) {
  if (!privateKey) throw new Error('privateKey required (use env PRIVATE_KEY or pass it)');
  if (!mint) throw new Error('mint required');
  if (!lpAmountUi) throw new Error('lpAmountUi required');

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

  let lpMintInfo;
  try {
    lpMintInfo = await getMint(connection, lpMint, 'processed', TOKEN_2022_PROGRAM_ID);
  } catch (_) {
    lpMintInfo = await getMint(connection, lpMint, 'processed', TOKEN_PROGRAM_ID);
  }
  const lpDecimals = lpMintInfo.decimals;

  const lpAmountRaw = BigInt(Math.floor(lpAmountUi * 10 ** lpDecimals));

  // Placeholder min out (improve with reserve quote if needed)
  const minBaseOut = 0n;
  const minQuoteOut = 0n;

  const data = Buffer.concat([
    WITHDRAW_DISCRIMINATOR,
    u64ToBuffer(lpAmountRaw),
    u64ToBuffer(minBaseOut),
    u64ToBuffer(minQuoteOut),
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

  const withdrawIx = new TransactionInstruction({
    programId: PUMP_SWAP_PROGRAM_ID,
    keys: accounts,
    data,
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicrolamports(600_000) }),
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userBaseAta, wallet.publicKey, mintPk, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userQuoteAta, wallet.publicKey, quoteMintPk, TOKEN_PROGRAM_ID),
    withdrawIx
  );

  tx.feePayer = wallet.publicKey;
  const latestBlockhash = await connection.getLatestBlockhash('processed');
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.sign(wallet);

  if (simulate) {
    const sim = await connection.simulateTransaction(tx, [wallet], { commitment: 'processed' });
    if (sim.value.err) {
      throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}\nLogs:\n${sim.value.logs?.join('\n') || 'No logs'}`);
    }
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

// CLI parsing
if (require.main === module) {
  const args = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < args.length; i += 2) {
    let key = args[i].replace(/^--/, '');
    // Normalize kebab-case to camelCase: --lp-amount → lpAmount
    key = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = args[i + 1];
    params[key] = value;
  }

  const {
    mint,
    lpAmount: lpAmountUiStr,
    slippageBps = '50',
    simulate = 'false',
  } = params;

  if (!mint || !lpAmountUiStr) {
    console.error('Usage: node removeLiquidity.js --mint <CA> --lpAmount <UI_AMOUNT> [--slippageBps 50] [--simulate true] [--keyfile <WALLET_JSON>]');
    console.error('Example: node removeLiquidity.js --mint CoPRYLGHc7Qadere13xSPhRvgwwStCZn9dHpBZQ7pump --lpAmount 1000 --simulate true --keyfile ./wallets/main.json');
    process.exit(1);
  }

  const resolvedPrivateKey = params.keyfile
    ? getPrivateKeyFromFile(params.keyfile)
    : (process.env.PRIVATE_KEY || params.privateKey);

  removeLiquidityPumpSwap({
    privateKey: resolvedPrivateKey,
    mint,
    lpAmountUi: parseFloat(lpAmountUiStr),
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

module.exports = { removeLiquidityPumpSwap };