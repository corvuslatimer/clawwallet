#!/usr/bin/env node

const { connection } = require('./solana/connection');
const { RPC_URL } = require('./config/constants');

const { buy } = require('./pump/buy');
const { sell } = require('./pump/sell');
const { deploy, deploy2 } = require('./pump/deploy');
const { claim, claimMintFee } = require('./pump/claim');
const { getPrivateKeyFromFile, getKeypairFromFile } = require('./utils/wallet');
const { addLaunch, listLaunches, getLaunch, setLauncherWallet } = require('./launcher/launchermap');

const VERSION = 'v1.4';

function parseArgv(argv) {
  const positionals = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    if (!body) continue;

    if (body.includes('=')) {
      const [k, ...rest] = body.split('=');
      flags[k] = rest.join('=');
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }

  return { positionals, flags };
}

function usage() {
  console.log('Usage: node cli.js <command> [flags]');
  console.log('');
  console.log('Migrated commands:');
  console.log('  buy --keyfile <WALLET_JSON> --mint <MINT> --sol <AMOUNT> [--slippageBps <BPS>]');
  console.log('  sell --keyfile <WALLET_JSON> --mint <MINT> --amount <AMOUNT> [--slippageBps <BPS>]');
  console.log('  deploy --keyfile <WALLET_JSON> --mintkeyfile <MINT_KEYPAIR_JSON> --name <NAME> --symbol <SYMBOL> --uri <METADATA_URI> [--initialBuySol <SOL>] [--slippageBps <BPS>] [--simulate]');
  console.log('  deploy2 --keyfile <WALLET_JSON> --mintkeyfile <MINT_KEYPAIR_JSON> --name <NAME> --symbol <SYMBOL> --uri <METADATA_URI> --recipients <w1,w2> --bps <8000,2000> [--initialBuySol <SOL>] [--slippageBps <BPS>] [--launcherId <ID>] [--simulate]');
  console.log('  claim --keyfile <WALLET_JSON>');
  console.log('  claim-mint --keyfile <WALLET_JSON> --mint <MINT> [--launcherId <ID>] [--simulate]');
  console.log('  launchermap list|get|set|add ...');
  console.log('  check');
}

function requireFlag(flags, name, usageText) {
  const v = flags[name];
  if (v === undefined || v === null || v === true || v === '') {
    throw new Error(usageText || `Missing --${name}`);
  }
  return v;
}

async function runLaunchermap(sub, args, flags) {
  if (!sub || sub === 'list') {
    console.log(JSON.stringify(listLaunches(), null, 2));
    return;
  }

  if (sub === 'get') {
    const launcherId = args[0] || flags.launcher;
    if (!launcherId) throw new Error('Usage: launchermap get <LAUNCHER_ID>');
    console.log(JSON.stringify(getLaunch(launcherId), null, 2));
    return;
  }

  if (sub === 'set') {
    const launcherId = args[0] || flags.launcher;
    const wallet = args[1] || flags.wallet;
    if (!launcherId || !wallet) throw new Error('Usage: launchermap set <LAUNCHER_ID> <WALLET_PUBKEY>');
    const entry = setLauncherWallet({ launcherId, wallet });
    console.log(JSON.stringify({ launcherId, ...entry }, null, 2));
    return;
  }

  if (sub === 'add') {
    const launcherId = flags.launcher || args[0];
    const mint = flags.mint || args[1];
    const creatorWallet = flags.wallet || args[2];
    if (!launcherId || !mint || !creatorWallet) {
      throw new Error('Usage: launchermap add --launcher <ID> --mint <MINT> --wallet <WALLET>');
    }
    const entry = addLaunch({ launcherId, mint, creatorWallet });
    console.log(JSON.stringify({ launcherId, ...entry }, null, 2));
    return;
  }

  throw new Error('Usage: launchermap [list|get|set|add] ...');
}

async function main() {
  const { positionals, flags } = parseArgv(process.argv.slice(2));
  const cmd = positionals[0];

  if (!cmd || ['help', '-h', '--help'].includes(cmd)) {
    usage();
    return;
  }

  if (cmd === 'launchermap') {
    await runLaunchermap(positionals[1], positionals.slice(2), flags);
    return;
  }

  if (cmd === 'buy') {
    const keyfile = requireFlag(flags, 'keyfile', 'Missing --keyfile');
    const mint = requireFlag(flags, 'mint', 'Missing --mint');
    const sol = Number(requireFlag(flags, 'sol', 'Missing --sol'));
    if (!Number.isFinite(sol) || sol <= 0) throw new Error('--sol must be a positive number');
    const slippageBps = Number(flags.slippageBps ?? flags.slippage ?? 500);
    const privateKey = getPrivateKeyFromFile(keyfile);
    const res = await buy({ privateKey, mint, sol, slippageBps });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'sell') {
    const keyfile = requireFlag(flags, 'keyfile', 'Missing --keyfile');
    const mint = requireFlag(flags, 'mint', 'Missing --mint');
    const amount = requireFlag(flags, 'amount', 'Missing --amount');
    const slippageBps = Number(flags.slippageBps ?? flags.slippage ?? 500);
    const privateKey = getPrivateKeyFromFile(keyfile);
    const res = await sell({ privateKey, mint, amount, slippageBps });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'deploy') {
    const keyfile = requireFlag(flags, 'keyfile', 'Missing --keyfile');
    const mintkeyfile = requireFlag(flags, 'mintkeyfile', 'Missing --mintkeyfile');
    const name = requireFlag(flags, 'name', 'Missing --name');
    const symbol = requireFlag(flags, 'symbol', 'Missing --symbol');
    const metadataUri = requireFlag(flags, 'uri', 'Missing --uri');
    const initialBuySol = Number(flags.initialBuySol ?? 0);
    const slippageBps = Number(flags.slippageBps ?? flags.slippage ?? 1000);
    const simulate = !!flags.simulate;

    const privateKey = getPrivateKeyFromFile(keyfile);
    const mintKeypair = getKeypairFromFile(mintkeyfile);

    const res = await deploy({
      privateKey,
      mintKeypair,
      name,
      symbol,
      metadataUri,
      initialBuySol,
      slippageBps,
      simulate,
    });
    console.log(JSON.stringify(res, null, 2));
    console.log(`DEPLOY_PROOF tx=${res.tx ?? res.signature ?? 'simulated'} mint=${res.mint} creator=${res.creator ?? 'unknown'} fee_mode=${res.fee_mode ?? 'unknown'} recipients=${JSON.stringify(res.recipients ?? [])}`);
    return;
  }

  if (cmd === 'deploy2') {
    const keyfile = requireFlag(flags, 'keyfile', 'Missing --keyfile');
    const mintkeyfile = requireFlag(flags, 'mintkeyfile', 'Missing --mintkeyfile');
    const name = requireFlag(flags, 'name', 'Missing --name');
    const symbol = requireFlag(flags, 'symbol', 'Missing --symbol');
    const metadataUri = requireFlag(flags, 'uri', 'Missing --uri');
    const recipientsRaw = requireFlag(flags, 'recipients', 'Missing --recipients');
    const bpsRaw = requireFlag(flags, 'bps', 'Missing --bps');
    const initialBuySol = Number(flags.initialBuySol ?? 0);
    const slippageBps = Number(flags.slippageBps ?? flags.slippage ?? 1000);
    const launcherId = flags.launcherId ? String(flags.launcherId) : null;
    const simulate = !!flags.simulate;

    const recipients = String(recipientsRaw).split(',').map((s) => s.trim()).filter(Boolean);
    const bps = String(bpsRaw).split(',').map((s) => Number(s.trim()));
    if (recipients.length !== bps.length) throw new Error('recipients and bps counts must match');
    if (bps.some((x) => !Number.isFinite(x) || x <= 0)) throw new Error('all bps values must be positive numbers');

    const privateKey = getPrivateKeyFromFile(keyfile);
    const mintKeypair = getKeypairFromFile(mintkeyfile);

    const res = await deploy2({
      privateKey,
      mintKeypair,
      name,
      symbol,
      metadataUri,
      recipients,
      bps,
      initialBuySol,
      slippageBps,
      launcherId,
      simulate,
    });
    console.log(JSON.stringify(res, null, 2));
    console.log(`DEPLOY_PROOF tx=${res.tx ?? res.signature ?? 'simulated'} mint=${res.mint} creator=${res.creator ?? 'unknown'} fee_mode=${res.fee_mode ?? 'unknown'} recipients=${JSON.stringify(res.recipients ?? [])}`);
    return;
  }

  if (cmd === 'claim') {
    const keyfile = requireFlag(flags, 'keyfile', 'Missing --keyfile');
    const res = await claim({ keyfile });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'claim-mint') {
    const keyfile = requireFlag(flags, 'keyfile', 'Missing --keyfile');
    const mint = requireFlag(flags, 'mint', 'Missing --mint');
    const launcherId = flags.launcherId ? String(flags.launcherId) : null;
    const simulate = !!flags.simulate;
    const privateKey = getPrivateKeyFromFile(keyfile);
    const res = await claimMintFee({ privateKey, mint, launcherId, simulate });
    console.log(JSON.stringify(res, null, 2));
    console.log(`CLAIM_PROOF tx=${res.tx ?? res.signature ?? 'simulated'} mint=${res.mint ?? mint} claimed_SOL=${res.claimed_sol ?? '0.000000'}`);
    return;
  }

  if (cmd === 'check') {
    await connection.getLatestBlockhash('confirmed');
    console.log(JSON.stringify({ ok: true, rpc: RPC_URL, version: VERSION }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${cmd}. Run 'node cli.js help' for supported commands.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
