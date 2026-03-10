'use strict';

/**
 * Production-safe SOL -> Token swap via Jupiter (CommonJS, Node 18+)
 *
 * Features:
 * - buyToken({ privateKey, mint, sol, slippageBps })
 * - Auto-detects legacy SPL Token vs Token-2022 by reading mint owner program on-chain
 * - Jupiter Quote + Swap Instructions (build tx yourself)
 * - Builds VersionedTransaction v0 with Address Lookup Tables (ALTs) when required
 * - Local signing with @solana/web3.js
 * - Robust retries: 429 backoff with jitter, RPC/network retries, blockhash-expiry rebuild + re-sign
 * - Simulation log extraction on failure
 * - Explicit guardrails to prevent Jupiter 0x177e / IncorrectTokenProgramID when using platform fees
 *
 * Environment (optional):
 * - RPC_URL                      (default: https://api.mainnet-beta.solana.com)
 * - COMMITMENT                   (default: confirmed)
 *
 * Jupiter API:
 * - JUPITER_BASE_URL             (optional; examples: https://lite-api.jup.ag , https://api.jup.ag , https://quote-api.jup.ag/v6)
 * - JUPITER_API_KEY              (optional; sent as x-api-key)
 * - JUPITER_TIMEOUT_MS           (default: 15000)
 * - JUPITER_HTTP_RETRIES         (default: 6)
 *
 * Platform fee (disabled by default):
 * - PLATFORM_FEE_BPS             (uint16; e.g. 20 for 0.20%)
 * - FEE_ACCOUNT                  (token account pubkey that receives fees; MUST already exist)
 * - FEE_MINT_SIDE                ("output" or "input"; default: "output")
 *
 * Transaction landing (optional):
 * - PRIORITY_LEVEL               (e.g. "medium"|"high"|"veryHigh") used with priorityLevelWithMaxLamports
 * - PRIORITY_MAX_LAMPORTS        (e.g. 1000000)
 */

const bs58Raw = require('bs58');
const bs58 = bs58Raw.default || bs58Raw;
const {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} = require('@solana/web3.js');

/** Program IDs */
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'); // legacy SPL Token
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'); // Token-2022
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

class HttpError extends Error {
  constructor(message, status, url, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

class SwapExecutionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'SwapExecutionError';
    this.details = details || {};
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterMs(ms, ratio = 0.2) {
  const delta = ms * ratio;
  const min = Math.max(0, ms - delta);
  const max = ms + delta;
  return Math.floor(min + Math.random() * (max - min));
}

function backoffMs(attempt, baseMs, maxMs) {
  const exp = baseMs * Math.pow(2, attempt);
  return Math.min(maxMs, exp);
}

function isProbablyRateLimit(err) {
  const msg = String(err && err.message ? err.message : err);
  return (
    msg.includes('429') ||
    msg.toLowerCase().includes('too many requests') ||
    (err && err.status === 429)
  );
}

function isProbablyBlockhashExpired(err) {
  const msg = String(err && err.message ? err.message : err).toLowerCase();
  return (
    msg.includes('blockhash not found') ||
    msg.includes('blockhashnotfound') ||
    msg.includes('transactionexpiredblockheightexceeded') ||
    msg.includes('block height exceeded') ||
    msg.includes('expired') ||
    msg.includes('not found')
  );
}

function looksLikeIncorrectTokenProgramId(err, logsJoined) {
  const msg = String(err && err.message ? err.message : err);
  const haystack = `${msg}\n${logsJoined || ''}`.toLowerCase();
  return (
    haystack.includes('incorrecttokenprogramid') ||
    haystack.includes('incorrect token program id') ||
    haystack.includes('0x177e') ||
    haystack.includes('6014')
  );
}

function parseJsonLenient(text) {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

async function getFetchFn() {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);

  // Fallback is rarely needed on Node 18+, but included for completeness.
  try {
    // CommonJS-compatible fetch shim
    // npm: node-fetch-commonjs
    return require('node-fetch-commonjs');
  } catch (e1) {
    try {
      const mod = await import('node-fetch-commonjs');
      return (mod && (mod.default || mod)) || null;
    } catch (e2) {
      throw new Error(
        'No global fetch available and failed to load node-fetch-commonjs. Use Node 18+ or install node-fetch-commonjs.'
      );
    }
  }
}

async function fetchJsonWithRetry(url, options, retryCfg) {
  const cfg = retryCfg || {};
  const retries = Number.isFinite(cfg.retries) ? cfg.retries : 6;
  const timeoutMs = Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 15000;
  const baseDelayMs = Number.isFinite(cfg.baseDelayMs) ? cfg.baseDelayMs : 350;
  const maxDelayMs = Number.isFinite(cfg.maxDelayMs) ? cfg.maxDelayMs : 7000;

  const fetchFn = await getFetchFn();

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetchFn(url, {
        ...options,
        signal: controller.signal,
      });

      if (resp.status === 429) {
        const retryAfter = resp.headers && resp.headers.get ? resp.headers.get('retry-after') : null;
        const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : null;
        const wait = jitterMs(
          Number.isFinite(retryAfterMs) ? retryAfterMs : backoffMs(attempt, baseDelayMs, maxDelayMs)
        );
        if (attempt === retries) {
          const text = await resp.text().catch(() => '');
          throw new HttpError(`HTTP 429 from ${url}`, 429, url, text);
        }
        await sleep(wait);
        continue;
      }

      const text = await resp.text().catch(() => '');
      const json = parseJsonLenient(text);
      if (!resp.ok) {
        throw new HttpError(`HTTP ${resp.status} from ${url}`, resp.status, url, json || text);
      }
      return json;
    } catch (err) {
      const isAbort = String(err && err.name) === 'AbortError';
      const lastAttempt = attempt === retries;
      if (lastAttempt) throw err;

      // Retry on 429/5xx/network/timeout
      const shouldRetry =
        isAbort ||
        isProbablyRateLimit(err) ||
        (err instanceof HttpError && err.status >= 500) ||
        String(err && err.message ? err.message : err).includes('ECONNRESET') ||
        String(err && err.message ? err.message : err).includes('ENOTFOUND');

      if (!shouldRetry) throw err;

      const wait = jitterMs(backoffMs(attempt, baseDelayMs, maxDelayMs));
      await sleep(wait);
    } finally {
      clearTimeout(t);
    }
  }

  throw new Error('fetchJsonWithRetry fell through unexpectedly');
}

function parsePrivateKeyToKeypair(privateKey) {
  if (privateKey instanceof Keypair) return privateKey;
  if (privateKey instanceof Uint8Array) return Keypair.fromSecretKey(privateKey);
  if (Array.isArray(privateKey)) return Keypair.fromSecretKey(Uint8Array.from(privateKey));

  if (typeof privateKey !== 'string') {
    throw new Error('privateKey must be a base58 string, JSON array string, Uint8Array, number[], or Keypair');
  }

  const trimmed = privateKey.trim();

  // Solana CLI style: "[12,34,...]"
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) throw new Error('Invalid JSON privateKey array');
    const bytes = Uint8Array.from(arr);
    // Most common: 64-byte secretKey
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    // Sometimes: 32-byte seed
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    throw new Error(`Unexpected key length from JSON array: ${bytes.length} bytes`);
  }

  // Base58 secret key
  const decoded = bs58.decode(trimmed);
  if (decoded.length === 64) return Keypair.fromSecretKey(Uint8Array.from(decoded));
  if (decoded.length === 32) return Keypair.fromSeed(Uint8Array.from(decoded));
  throw new Error(`Unexpected key length from base58: ${decoded.length} bytes`);
}

function solToLamportsBigInt(sol) {
  if (typeof sol === 'number') {
    if (!Number.isFinite(sol) || sol <= 0) throw new Error('sol must be a positive number');
    // Convert via string path to reduce float surprises for typical CLI inputs.
    return solToLamportsBigInt(String(sol));
  }

  if (typeof sol !== 'string') throw new Error('sol must be a number or decimal string');

  const s = sol.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid SOL amount: ${sol}`);

  const [whole, fracRaw] = s.split('.');
  const frac = (fracRaw || '').padEnd(9, '0').slice(0, 9);
  return BigInt(whole) * 1000000000n + BigInt(frac);
}

async function getMintTokenProgramId(connection, mintPubkey) {
  const info = await connection.getAccountInfo(mintPubkey, { commitment: 'confirmed' });
  if (!info) throw new Error(`Mint account not found: ${mintPubkey.toBase58()}`);

  const owner = info.owner;
  if (owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;

  throw new Error(
    `Unsupported mint owner program: ${owner.toBase58()} for mint ${mintPubkey.toBase58()}`
  );
}

function deriveAssociatedTokenAddress(ownerPubkey, mintPubkey, tokenProgramId) {
  const [ata] = PublicKey.findProgramAddressSync(
    [ownerPubkey.toBuffer(), tokenProgramId.toBuffer(), mintPubkey.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function readPubkeyFromData(data, offset) {
  return new PublicKey(data.slice(offset, offset + 32));
}

function validateTokenAccountLayout(accountInfo, expectedMint, expectedTokenProgramId, label) {
  if (!accountInfo) throw new Error(`${label}: accountInfo missing`);
  if (!accountInfo.owner.equals(expectedTokenProgramId)) {
    throw new Error(
      `${label}: token account owner program mismatch. Expected ${expectedTokenProgramId.toBase58()} but got ${accountInfo.owner.toBase58()}`
    );
  }
  if (!accountInfo.data || accountInfo.data.length < 64) {
    throw new Error(`${label}: token account data too short`);
  }
  const mintInAccount = readPubkeyFromData(accountInfo.data, 0);
  if (!mintInAccount.equals(expectedMint)) {
    throw new Error(
      `${label}: token account mint mismatch. Expected ${expectedMint.toBase58()} but got ${mintInAccount.toBase58()}`
    );
  }
}

let _splTokenModulePromise = null;
async function loadSplTokenModule() {
  if (_splTokenModulePromise) return _splTokenModulePromise;

  _splTokenModulePromise = (async () => {
    try {
      return require('@solana/spl-token');
    } catch (_e) {
      // If the package is ESM-only in some environments, fall back to dynamic import.
      const mod = await import('@solana/spl-token');
      return mod && (mod.default || mod);
    }
  })();

  return _splTokenModulePromise;
}

async function ensureAtaExists({
  connection,
  payerKeypair,
  ownerPubkey,
  mintPubkey,
  tokenProgramId,
  commitment,
}) {
  const ata = deriveAssociatedTokenAddress(ownerPubkey, mintPubkey, tokenProgramId);
  const info = await connection.getAccountInfo(ata, { commitment: commitment || 'confirmed' });

  if (info) {
    validateTokenAccountLayout(info, mintPubkey, tokenProgramId, 'ATA validation');
    return { ata, created: false };
  }

  const splToken = await loadSplTokenModule();
  if (!splToken || typeof splToken.createAssociatedTokenAccountIdempotentInstruction !== 'function') {
    throw new Error('Failed to load @solana/spl-token createAssociatedTokenAccountIdempotentInstruction');
  }

  const ix = splToken.createAssociatedTokenAccountIdempotentInstruction(
    payerKeypair.publicKey,
    ata,
    ownerPubkey,
    mintPubkey,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const { signature } = await sendVersionedTransactionWithRetries({
    connection,
    payerKeypair,
    instructions: [ix],
    lookupTableAddresses: [],
    commitment: commitment || 'confirmed',
    label: 'create-ata-idempotent',
  });

  // Confirmed, but also validate it exists and matches.
  const createdInfo = await connection.getAccountInfo(ata, { commitment: commitment || 'confirmed' });
  if (!createdInfo) {
    throw new Error(`ATA creation transaction confirmed but ATA not found: ${ata.toBase58()} (sig: ${signature})`);
  }
  validateTokenAccountLayout(createdInfo, mintPubkey, tokenProgramId, 'ATA post-create validation');

  return { ata, created: true };
}

function normalizeJupiterBaseUrl() {
  const envBase = process.env.JUPITER_BASE_URL && process.env.JUPITER_BASE_URL.trim();
  if (envBase) return envBase.replace(/\/+$/, '');

  // From Jupiter updates, api.jup.ag typically requires an API key, while lite-api is used for free access.
  // We auto-select based on whether an API key is present.
  const hasKey = Boolean(process.env.JUPITER_API_KEY && process.env.JUPITER_API_KEY.trim());
  return (hasKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag').replace(/\/+$/, '');
}

function resolveJupiterEndpoints(baseUrl) {
  const b = (baseUrl || '').replace(/\/+$/, '');

  // Supported patterns:
  // - https://api.jup.ag          -> /swap/v1/quote , /swap/v1/swap-instructions
  // - https://lite-api.jup.ag     -> /swap/v1/quote , /swap/v1/swap-instructions
  // - https://api.jup.ag/swap/v1  -> /quote , /swap-instructions
  // - https://quote-api.jup.ag/v6 -> /quote , /swap-instructions (legacy)
  const lower = b.toLowerCase();

  if (lower.endsWith('/swap/v1')) {
    return {
      quoteUrl: `${b}/quote`,
      swapInstructionsUrl: `${b}/swap-instructions`,
      flavor: 'swap-v1',
    };
  }
  if (lower.includes('/v6')) {
    return {
      quoteUrl: `${b}/quote`,
      swapInstructionsUrl: `${b}/swap-instructions`,
      flavor: 'v6-legacy',
    };
  }
  return {
    quoteUrl: `${b}/swap/v1/quote`,
    swapInstructionsUrl: `${b}/swap/v1/swap-instructions`,
    flavor: 'swap-v1',
  };
}

function buildJupiterHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  };
  const apiKey = process.env.JUPITER_API_KEY && process.env.JUPITER_API_KEY.trim();
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

async function jupiterGetQuote({
  inputMint,
  outputMint,
  amount,
  slippageBps,
  platformFeeBps,
  instructionVersion,
  maxAccounts,
}) {
  const baseUrl = normalizeJupiterBaseUrl();
  const { quoteUrl } = resolveJupiterEndpoints(baseUrl);

  const qs = new URLSearchParams();
  qs.set('inputMint', inputMint);
  qs.set('outputMint', outputMint);
  qs.set('amount', String(amount));
  qs.set('slippageBps', String(slippageBps));

  // Keep routing safer by default
  qs.set('restrictIntermediateTokens', 'true');

  if (Number.isFinite(maxAccounts)) qs.set('maxAccounts', String(maxAccounts));

  // Fees are optional. Jupiter notes that if platformFeeBps is passed, feeAccount must be passed in /swap.
  if (Number.isFinite(platformFeeBps) && platformFeeBps > 0) {
    qs.set('platformFeeBps', String(platformFeeBps));
  }

  // Instruction version V2 is needed in certain fee + Token-2022 cases.
  if (instructionVersion) qs.set('instructionVersion', instructionVersion);

  const timeoutMs = Number(process.env.JUPITER_TIMEOUT_MS || '15000');
  const retries = Number(process.env.JUPITER_HTTP_RETRIES || '6');

  const json = await fetchJsonWithRetry(`${quoteUrl}?${qs.toString()}`, {
    method: 'GET',
    headers: buildJupiterHeaders(),
  }, { retries, timeoutMs });

  // Normalize common response shapes:
  // - swap/v1: QuoteResponse object directly
  // - v6 legacy: { data: [QuoteResponse, ...], ... }
  if (json && typeof json === 'object') {
    if (json.error) {
      throw new Error(`Jupiter quote error: ${json.error}`);
    }
    if (json.errorCode || json.errorMessage) {
      throw new Error(`Jupiter quote error: ${json.errorCode || ''} ${json.errorMessage || ''}`.trim());
    }
    if (Array.isArray(json.data) && json.data.length > 0) {
      return json.data[0];
    }
    return json;
  }

  throw new Error('Unexpected Jupiter quote response');
}

function deserializeJupiterInstruction(ix) {
  if (!ix) return null;
  if (!ix.programId || !ix.accounts) {
    throw new Error(`Malformed instruction from Jupiter: ${JSON.stringify(ix)}`);
  }
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: Boolean(a.isSigner),
      isWritable: Boolean(a.isWritable),
    })),
    data: Buffer.from(ix.data || '', 'base64'),
  });
}

async function jupiterGetSwapInstructions({
  quoteResponse,
  userPublicKey,
  destinationTokenAccount,
  feeAccount,
  dynamicComputeUnitLimit,
  dynamicSlippage,
  prioritizationFeeLamports,
}) {
  const baseUrl = normalizeJupiterBaseUrl();
  const { swapInstructionsUrl } = resolveJupiterEndpoints(baseUrl);

  const body = {
    quoteResponse,
    userPublicKey,
    payer: userPublicKey,
    wrapAndUnwrapSol: true,
    useSharedAccounts: false,
    asLegacyTransaction: false,
    destinationTokenAccount,
    dynamicComputeUnitLimit: Boolean(dynamicComputeUnitLimit),
    dynamicSlippage: Boolean(dynamicSlippage),
  };

  if (feeAccount) body.feeAccount = feeAccount;
  if (prioritizationFeeLamports) body.prioritizationFeeLamports = prioritizationFeeLamports;

  const timeoutMs = Number(process.env.JUPITER_TIMEOUT_MS || '15000');
  const retries = Number(process.env.JUPITER_HTTP_RETRIES || '6');

  const json = await fetchJsonWithRetry(swapInstructionsUrl, {
    method: 'POST',
    headers: buildJupiterHeaders(),
    body: JSON.stringify(body),
  }, { retries, timeoutMs });

  if (json && typeof json === 'object') {
    if (json.error) {
      throw new Error(`Jupiter swap-instructions error: ${json.error}`);
    }
    if (json.errorCode || json.errorMessage) {
      throw new Error(`Jupiter swap-instructions error: ${json.errorCode || ''} ${json.errorMessage || ''}`.trim());
    }
    return json;
  }

  throw new Error('Unexpected Jupiter swap-instructions response');
}

async function fetchAddressLookupTableAccounts(connection, lookupTableAddresses, commitment) {
  const addrs = Array.isArray(lookupTableAddresses) ? lookupTableAddresses : [];
  if (addrs.length === 0) return [];

  const keys = addrs.map((a) => new PublicKey(a));
  const infos = await connection.getMultipleAccountsInfo(keys, { commitment: commitment || 'confirmed' });

  const accounts = [];
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (!info) continue;
    const state = AddressLookupTableAccount.deserialize(info.data);
    accounts.push(
      new AddressLookupTableAccount({
        key: keys[i],
        state,
      })
    );
  }
  return accounts;
}

async function simulateTxAndExtractLogs(connection, tx) {
  try {
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
    });
    const logs = (sim && sim.value && sim.value.logs) || [];
    const err = sim && sim.value && sim.value.err;
    return { logs, err };
  } catch (e) {
    return { logs: [], err: String(e && e.message ? e.message : e) };
  }
}

async function getOnchainLogsBySignature(connection, signature, commitment) {
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: commitment || 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    const meta = tx && tx.meta;
    return {
      err: meta ? meta.err : null,
      logs: meta ? meta.logMessages || [] : [],
    };
  } catch (e) {
    return { err: String(e && e.message ? e.message : e), logs: [] };
  }
}

async function sendVersionedTransactionWithRetries({
  connection,
  payerKeypair,
  instructions,
  lookupTableAddresses,
  commitment,
  label,
}) {
  const maxBlockhashRebuilds = 3;
  const sendRetries = 2;

  const luts = await fetchAddressLookupTableAccounts(connection, lookupTableAddresses, commitment || 'confirmed');

  let lastErr = null;
  for (let rebuildAttempt = 0; rebuildAttempt <= maxBlockhashRebuilds; rebuildAttempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment || 'confirmed');

    const messageV0 = new TransactionMessage({
      payerKey: payerKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(luts);

    const tx = new VersionedTransaction(messageV0);
    tx.sign([payerKeypair]);

    let signature = null;

    for (let sendAttempt = 0; sendAttempt <= sendRetries; sendAttempt++) {
      try {
        signature = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'processed',
          maxRetries: 2,
        });

        const conf = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          commitment || 'confirmed'
        );

        if (conf && conf.value && conf.value.err) {
          const onchain = await getOnchainLogsBySignature(connection, signature, commitment || 'confirmed');
          const logsJoined = (onchain.logs || []).join('\n');
          const errMsg = `${label || 'tx'} confirmed with error: ${JSON.stringify(conf.value.err)}`;

          // Provide enriched logs; also include simulation fallback if logs missing.
          let sim = { logs: [], err: null };
          if (!onchain.logs || onchain.logs.length === 0) {
            sim = await simulateTxAndExtractLogs(connection, tx);
          }

          throw new SwapExecutionError(errMsg, {
            signature,
            confirmErr: conf.value.err,
            onchainLogs: onchain.logs || [],
            simulationErr: sim.err,
            simulationLogs: sim.logs || [],
          });
        }

        return { signature, blockhash, lastValidBlockHeight };
      } catch (e) {
        lastErr = e;

        // If we already have a signature, attempt to fetch logs to enrich the thrown error.
        if (signature) {
          const onchain = await getOnchainLogsBySignature(connection, signature, commitment || 'confirmed');
          const logsJoined = (onchain.logs || []).join('\n');

          if (looksLikeIncorrectTokenProgramId(e, logsJoined)) {
            const sim = await simulateTxAndExtractLogs(connection, tx);
            throw new SwapExecutionError(
              'Swap failed with IncorrectTokenProgramID (0x177e/6014). This usually means a Token-2022 mint was used with a feeAccount or token account owned by the wrong token program.',
              {
                signature,
                originalError: String(e && e.message ? e.message : e),
                onchainErr: onchain.err,
                onchainLogs: onchain.logs || [],
                simulationErr: sim.err,
                simulationLogs: sim.logs || [],
              }
            );
          }
        }

        if (isProbablyRateLimit(e)) {
          const wait = jitterMs(backoffMs(sendAttempt, 300, 5000));
          await sleep(wait);
          continue;
        }

        if (e instanceof SwapExecutionError) throw e;
        if (e instanceof HttpError) throw e;

        // Blockhash expiry: rebuild message with a fresh blockhash.
        if (isProbablyBlockhashExpired(e)) {
          break;
        }

        // Other transient errors: small backoff once.
        const wait = jitterMs(backoffMs(sendAttempt, 250, 2500));
        await sleep(wait);

        // If final attempt, throw.
        if (sendAttempt === sendRetries) throw e;
      }
    }
  }

  throw lastErr || new Error('Failed to send transaction after retries');
}

function buildPrioritizationFeeConfigFromEnv() {
  const level = process.env.PRIORITY_LEVEL && process.env.PRIORITY_LEVEL.trim();
  const maxLamportsStr = process.env.PRIORITY_MAX_LAMPORTS && process.env.PRIORITY_MAX_LAMPORTS.trim();

  if (!level || !maxLamportsStr) return null;

  const maxLamports = Number(maxLamportsStr);
  if (!Number.isFinite(maxLamports) || maxLamports <= 0) return null;

  return {
    priorityLevelWithMaxLamports: {
      priorityLevel: level,
      maxLamports,
      global: false,
    },
  };
}

/**
 * Main API: buy SOL -> token mint via Jupiter.
 *
 * @param {Object} params
 * @param {string|Uint8Array|number[]|Keypair} params.privateKey
 * @param {string} params.mint - Output mint address
 * @param {string|number} params.sol - SOL amount (e.g. "0.01")
 * @param {number} params.slippageBps - e.g. 50 = 0.50%
 * @returns {Promise<Object>} details including signature and resolved token program IDs
 */
async function buyToken({ privateKey, mint, sol, slippageBps }) {
  if (!mint) throw new Error('mint is required');
  if (!sol) throw new Error('sol is required');
  if (!Number.isFinite(Number(slippageBps)) || Number(slippageBps) < 0) {
    throw new Error('slippageBps must be a non-negative number');
  }

  const payer = parsePrivateKeyToKeypair(privateKey);
  const outputMint = new PublicKey(mint);
  const lamports = solToLamportsBigInt(sol);
  const commitment = (process.env.COMMITMENT || 'confirmed').trim();

  const rpcUrl = (process.env.RPC_URL && process.env.RPC_URL.trim()) || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, {
    commitment,
    confirmTransactionInitialTimeout: 60_000,
  });

  // Detect token program for output mint (legacy vs Token-2022)
  const outputTokenProgramId = await getMintTokenProgramId(connection, outputMint);

  // Destination token account MUST be derived with the correct token program ID (Tokenkeg vs Token-2022).
  const { ata: destinationAta, created: destinationCreated } = await ensureAtaExists({
    connection,
    payerKeypair: payer,
    ownerPubkey: payer.publicKey,
    mintPubkey: outputMint,
    tokenProgramId: outputTokenProgramId,
    commitment,
  });

  // Optional platform fee. Disabled by default, and guarded to prevent IncorrectTokenProgramID.
  const platformFeeBpsRaw = process.env.PLATFORM_FEE_BPS && process.env.PLATFORM_FEE_BPS.trim();
  const feeAccountRaw = process.env.FEE_ACCOUNT && process.env.FEE_ACCOUNT.trim();
  const feeMintSide = (process.env.FEE_MINT_SIDE || 'output').trim().toLowerCase();
  let platformFeeBps = null;
  let feeAccount = null;
  let instructionVersion = null;

  if (platformFeeBpsRaw) {
    const bps = Number(platformFeeBpsRaw);
    if (!Number.isFinite(bps) || bps <= 0 || bps > 10000) {
      throw new Error('PLATFORM_FEE_BPS must be an integer between 1 and 10000');
    }

    // Jupiter requires: if platformFeeBps is used in quote, feeAccount must be passed in swap.
    if (!feeAccountRaw) {
      // Safety: disable fees rather than accidentally triggering a mismatch.
      // You can switch this to throw if you prefer.
      platformFeeBps = null;
    } else {
      // Validate fee account: must be a token account for either input or output mint (ExactIn), and must
      // be owned by the correct token program for that mint (legacy vs Token-2022).
      const feeMint =
        feeMintSide === 'input'
          ? WSOL_MINT
          : outputMint;

      const feeMintTokenProgramId =
        feeMint.equals(WSOL_MINT) ? TOKEN_PROGRAM_ID : outputTokenProgramId;

      const feeAccountPk = new PublicKey(feeAccountRaw);
      const feeInfo = await connection.getAccountInfo(feeAccountPk, { commitment });

      if (!feeInfo) {
        // Safety: disable platform fee if the configured token account does not exist
        platformFeeBps = null;
      } else {
        validateTokenAccountLayout(feeInfo, feeMint, feeMintTokenProgramId, 'feeAccount validation');
        feeAccount = feeAccountPk.toBase58();
        platformFeeBps = bps;

        // Jupiter: instructionVersion=V2 is required to collect fees in Token-2022 tokens.
        if (feeMintTokenProgramId.equals(TOKEN_2022_PROGRAM_ID)) {
          instructionVersion = 'V2';
        }
      }
    }
  }

  // Quote: SOL (wSOL mint) -> output mint
  const quoteResponse = await jupiterGetQuote({
    inputMint: WSOL_MINT.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: lamports.toString(),
    slippageBps: Number(slippageBps),
    platformFeeBps: platformFeeBps,
    instructionVersion: instructionVersion,
    maxAccounts: 64,
  });

  const prioritizationFeeLamports = buildPrioritizationFeeConfigFromEnv();

  // Swap instructions: user builds the VersionedTransaction
  const swapIxResp = await jupiterGetSwapInstructions({
    quoteResponse,
    userPublicKey: payer.publicKey.toBase58(),
    destinationTokenAccount: destinationAta.toBase58(),
    feeAccount: feeAccount,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: false,
    prioritizationFeeLamports: prioritizationFeeLamports,
  });

  // Support common response shapes / field names:
  const computeBudgetInstructionsRaw = swapIxResp.computeBudgetInstructions || [];
  const setupInstructionsRaw = swapIxResp.setupInstructions || [];
  const otherInstructionsRaw = swapIxResp.otherInstructions || [];
  const cleanupInstructionRaw = swapIxResp.cleanupInstruction || null;

  // Some docs/snippets refer to swapInstruction payload with other names; handle both.
  const swapInstructionRaw = swapIxResp.swapInstruction || swapIxResp.swapInstructionPayload || swapIxResp.swap_instruction;
  if (!swapInstructionRaw) {
    throw new Error(`No swapInstruction found in Jupiter response: ${JSON.stringify(Object.keys(swapIxResp))}`);
  }

  const lutAddresses = swapIxResp.addressLookupTableAddresses || [];

  const instructions = [];

  for (const ix of computeBudgetInstructionsRaw) instructions.push(deserializeJupiterInstruction(ix));
  for (const ix of setupInstructionsRaw) instructions.push(deserializeJupiterInstruction(ix));
  for (const ix of otherInstructionsRaw) instructions.push(deserializeJupiterInstruction(ix));

  const swapIx = deserializeJupiterInstruction(swapInstructionRaw);
  instructions.push(swapIx);

  if (cleanupInstructionRaw) {
    const cleanupIx = deserializeJupiterInstruction(cleanupInstructionRaw);
    instructions.push(cleanupIx);
  }

  // Execute swap
  const { signature } = await sendVersionedTransactionWithRetries({
    connection,
    payerKeypair: payer,
    instructions,
    lookupTableAddresses: lutAddresses,
    commitment,
    label: 'jupiter-swap',
  });

  return {
    signature,
    destinationTokenAccount: destinationAta.toBase58(),
    destinationAtaCreated: destinationCreated,
    outputTokenProgramId: outputTokenProgramId.toBase58(),
    platformFeeBpsApplied: platformFeeBps || 0,
    feeAccountApplied: feeAccount || null,
    jupiterInstructionVersion: instructionVersion || 'V1',
    rpcUrl,
    jupiterBaseUrl: normalizeJupiterBaseUrl(),
  };
}

/* ---------------------------
 * Minimal runnable test snippet
 * ---------------------------
 *
 * Usage:
 *   npm i @solana/web3.js@1.98.4 @solana/spl-token@0.4.14 bs58@6.0.0 node-fetch-commonjs@3.3.2
 *   RPC_URL=https://... PRIVATE_KEY=... node jupiter-buy.js
 *
 * Notes:
 * - PRIVATE_KEY can be base58 or JSON array string
 * - By default, platform fees are disabled.
 * - If you set PLATFORM_FEE_BPS, you MUST set FEE_ACCOUNT, and it MUST be a valid token account for input or output mint.
 */

async function runTestsIfMain() {
  if (require.main !== module) return;

  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error('Missing env PRIVATE_KEY');
    process.exit(1);
  }

  // USDC (legacy SPL)
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  // Provided Token-2022 mint example (will be auto-detected on-chain)
  const TOKEN_2022_EXAMPLE = 'CoPRYLGHc7Qadere13xSPhRvgwwStCZn9dHpBZQ7pump';

  console.log('--- Test 1: buy 0.01 SOL of USDC ---');
  const r1 = await buyToken({
    privateKey: pk,
    mint: USDC_MINT,
    sol: '0.01',
    slippageBps: 50,
  });
  console.log('Result 1:', r1);

  console.log('--- Test 2: buy 0.01 SOL of Token-2022 example mint ---');
  const r2 = await buyToken({
    privateKey: pk,
    mint: TOKEN_2022_EXAMPLE,
    sol: '0.01',
    slippageBps: 500, // memecoins often require higher slippage; adjust to your risk tolerance
  });
  console.log('Result 2:', r2);
}

runTestsIfMain().catch((e) => {
  const details = e && e.details ? e.details : null;
  console.error('ERROR:', e && e.message ? e.message : e);
  if (details) {
    console.error('DETAILS:', JSON.stringify(details, null, 2));
  }
  process.exit(1);
});

module.exports = {
  buyToken,
  // Export helpers if you want to integrate into an existing CLI:
  deriveAssociatedTokenAddress,
  getMintTokenProgramId,
};
