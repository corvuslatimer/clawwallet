---
name: clawwallet
description: Solana CLI skill for clawwallet wallet operations, Pump deploy/buy/sell, PumpSwap add/remove liquidity, creator fee redirect/claim flows, WSOL unwrap, launcher isolation, and metadata/social upload via Pinata. Use when an agent needs to execute or debug clawwallet commands, run live/simulated token operations, or automate treasury routines with deterministic CLI outputs.
---

# Clawwallet Skill (Agent-Facing)

Use this skill to operate `/root/.openclaw/workspace/projects/clawwallet` safely and predictably.

## 1) Scope

This repo provides a modular Solana CLI for:
- wallet-backed buy/sell,
- Pump token deployment (single-tx create+buy path),
- creator fee claim + redirect,
- PumpSwap liquidity add/remove (current validated path for CoPR mapping),
- WSOL unwrap,
- launcher-based wallet isolation.

Primary entrypoint:
```bash
node cli.js
```

## 2) Runtime and env requirements

`RPC_URL` is **required** (env only).

Set in `.env` (recommended):
```bash
RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
PINATA_JWT=...
PINATA_GATEWAY=<your-subdomain>.mypinata.cloud
```

Notes:
- `config.json` fallback has been removed.
- Do not commit `.env` or wallet key files.

## 3) Command catalog

### Bitrefill (no package install)
- Integrated as a subcommand in main CLI:
```bash
node cli.js bitrefill help
node cli.js bitrefill list-tools
node cli.js bitrefill search --query "netflix" --country US
```
- Uses local script: `/root/.openclaw/workspace/projects/clawwallet/bitrefill/cli.js`.
- No `@bitrefill/cli` install required.
- If user is not authenticated, guide with a simple link-first flow:
  - Sign in/create API key: `https://www.bitrefill.com/account/developers`
  - Set `BITREFILL_API_KEY` and retry command.

### Core CLI
```bash
node cli.js check

node cli.js buy --keyfile <WALLET_JSON> --mint <MINT> --sol <AMOUNT> [--slippageBps <BPS>]
node cli.js sell --keyfile <WALLET_JSON> --mint <MINT> --amount <AMOUNT> [--slippageBps <BPS>]

node cli.js deploy --keyfile <WALLET_JSON> --mintkeyfile <MINT_KEYPAIR_JSON> --name <NAME> --symbol <SYMBOL> [--uri <METADATA_URI>] --initialBuySol <SOL> [--description <TEXT>] [--twitter <URL>] [--telegram <URL>] [--website <URL>] [--imageUri <URL>] [--slippageBps <BPS>] [--simulate]

node cli.js deploy2 --keyfile <WALLET_JSON> --mintkeyfile <MINT_KEYPAIR_JSON> --name <NAME> --symbol <SYMBOL> [--uri <METADATA_URI>] --recipients <w1,w2,...> --bps <8000,2000,...> --initialBuySol <SOL> [--description <TEXT>] [--twitter <URL>] [--telegram <URL>] [--website <URL>] [--imageUri <URL>] [--slippageBps <BPS>] [--launcherId <ID>] [--simulate]

node cli.js claim --keyfile <WALLET_JSON>
node cli.js claim-mint --keyfile <WALLET_JSON> --mint <MINT> [--launcherId <ID>] [--simulate]

node cli.js fee-redirect --keyfile <WALLET_JSON> --mint <MINT> --recipient <WALLET> [--bps <N>] [--simulate]
node cli.js unwrap-wsol --keyfile <WALLET_JSON> [--simulate]

node cli.js launchermap list|get|set|add ...
```

### PumpSwap scripts (standalone)
```bash
node pumpswap/addLiquidity.js --mint <MINT> --solAmount <SOL_UI> [--tokenAmount <TOKEN_UI>] [--slippageBps 50] [--simulate true|false] [--keyfile <WALLET_JSON>] [--privateKey <BASE58_OR_JSON>]
node pumpswap/removeLiquidity.js --mint <MINT> --lpAmount <LP_UI> [--slippageBps 50] [--simulate true|false] [--keyfile <WALLET_JSON>] [--privateKey <BASE58_OR_JSON>]
```

## 4) Behavior details

### buy / sell
- Handles both:
  - bonded/active curve path,
  - non-bonded (graduated) route.
- Applies priority fee and compute settings.

### deploy / deploy2
- Uses Pump create+buy flow.
- `--initialBuySol` is required and must be `> 0`.
- Metadata behavior:
  - If socials/description/image fields are provided, metadata JSON is uploaded to Pinata and resulting URI is used.
  - Otherwise provide `--uri` directly.
- Output includes `metadataUri` when available.

### fee-redirect
- Supports full or partial redirect with `--bps 1..10000`.
- If `<10000`, remaining BPS stays with signer.

### unwrap-wsol
- Closes WSOL ATA (`So111...`) and returns lamports to native SOL balance.
- Returns `skipped=true` if no WSOL balance exists.

### claim / claim-mint
- `claim`: wallet-wide creator-fee collection path.
- `claim-mint`: mint-scoped claim path with fallback logic where required.

## 5) PumpSwap caveat (important)

Current PumpSwap add/remove implementation is validated against known CoPR pool/account mapping used in live tests.

Credential handling for PumpSwap scripts:
- Prefer `--keyfile <WALLET_JSON>`.
- `--privateKey` / `PRIVATE_KEY` are compatibility-only fallbacks.

If you use another mint, verify/derive these correctly before live send:
- pool PDA/account,
- amm global config,
- LP mint,
- pool base/quote token vaults,
- instruction args for slippage-safe bounds.

Default: **simulate first** for all new mint/pool combinations.

## 6) Output contracts

Commands print JSON suitable for automation.

Proof lines:
- deploy/deploy2: `DEPLOY_PROOF ...`
- claim-mint: `CLAIM_PROOF ...`
- unwrap: `UNWRAP_PROOF ...` (when not skipped)

## 7) Updating local clawwallet from GitHub (agent runbook)

When asked to "update wallet" or "pull latest", use this exact flow:

```bash
cd /root/.openclaw/workspace/projects/clawwallet
git status
git fetch origin
git checkout main
git pull --ff-only origin main
npm install
node cli.js check
```

Rules:
- If `git status` is not clean, stash or commit local work before pulling.
- Do not delete or commit `.env` or `wallets/`.
- After update, always run `node cli.js check` before any live tx.

## 8) Safe operating checklist

Before live sends:
1. `node cli.js check`
2. Confirm signer wallet and mint are correct.
3. Run `--simulate` first when supported.
4. For PumpSwap, do simulation against target mint/pool before any live tx.
5. Never paste or commit private keys/JWTs in repo history.

After live sends:
1. Capture tx signature in logs/changelog.
2. If WSOL remains after liquidity ops, run `unwrap-wsol`.
3. For ops automation, parse JSON first, proof line second.
