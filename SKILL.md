---
name: clawwallet
description: Solana CLI skill for wallet operations, Pump deploy/buy/sell/claim workflows, launcher wallet isolation, and mint-specific creator fee claiming (including completed-curve PumpSwap pre-transfer + Pump distribute flow). Use when an agent needs to execute or debug clawwallet commands, validate claim behavior, or automate launch/treasury routines with deterministic CLI outputs.
---

# Clawwallet Skill (Agent-Facing)

Use this skill to run and debug `/root/.openclaw/workspace/projects/clawwallet` safely and deterministically.

## 1) Scope and intent

This repository is a modular Solana CLI focused on:
- wallet-backed trading (buy/sell),
- token deployment,
- fee-sharing launch flows,
- creator fee claiming (wallet-wide and mint-specific),
- launcher-based wallet/mint isolation.

Primary entrypoint:
```bash
node cli.js
```

## 2) Repository layout and responsibilities

- `cli.js`
  - Command router, argument parsing, help output, proof-line printing.
- `pump/`
  - `buy.js`: Pump buy path for active curves; Jupiter path for completed curves.
  - `sell.js`: Pump sell path for active curves; Jupiter path for completed curves.
  - `deploy.js`: deploy and deploy2 flows.
  - `claim.js`: wallet-wide claim and mint-specific claim logic.
  - `common.js`: shared curve/global state parsing, fee recipient resolution, quote math.
  - `feeSharing.js`: PDA validation + attribution helpers.
- `solana/`
  - `connection.js`: RPC connection.
  - `tx.js`: tx send helpers + priority fee computation.
  - `pda.js`: all core PDA derivations used by the CLI.
  - `pump-helpers.js`: helper parsing/quoting logic used across pump operations.
- `launcher/`
  - `launchermap.json` and helpers: maps launcher IDs to wallet + mints.
- `config/`
  - constants (`PUMP_PROGRAM_ID`, fee/swap programs, etc).
- `utils/`
  - key parsing, Anchor discriminator encoding, misc helpers.

## 3) Command catalog

```bash
node cli.js buy --keyfile <WALLET_JSON> --mint <MINT> --sol <AMOUNT> [--slippageBps <BPS>]
node cli.js sell --keyfile <WALLET_JSON> --mint <MINT> --amount <AMOUNT> [--slippageBps <BPS>]
node cli.js deploy --keyfile <WALLET_JSON> --mintkeyfile <MINT_KEYPAIR_JSON> --name <NAME> --symbol <SYMBOL> --uri <METADATA_URI> [--initialBuySol <SOL>] [--slippageBps <BPS>] [--simulate]
node cli.js deploy2 --keyfile <WALLET_JSON> --mintkeyfile <MINT_KEYPAIR_JSON> --name <NAME> --symbol <SYMBOL> --uri <METADATA_URI> --recipients <w1,w2,...> --bps <8000,2000,...> [--initialBuySol <SOL>] [--slippageBps <BPS>] [--launcherId <ID>] [--simulate]
node cli.js claim --keyfile <WALLET_JSON>
node cli.js claim-mint --keyfile <WALLET_JSON> --mint <MINT> [--launcherId <ID>] [--simulate]
node cli.js launchermap [list|get|set|add] ...
node cli.js check
node cli.js --help
```

## 4) Behavior details by feature

### A) `buy`
- Detects bonding curve state.
- If curve is active (`complete=false`): uses Pump program instruction path.
- If curve is complete: routes via Jupiter swap instructions.
- Applies compute budget and priority fee.

### B) `sell`
- Same split behavior as buy:
  - active curve => Pump sell,
  - completed curve => Jupiter route.

### C) `deploy` and `deploy2`
- `deploy`: standard deploy flow.
- `deploy2`: fee-sharing deploy flow with recipient split + BPS distribution.
- `--simulate` supported to dry-run before send.

### D) `claim` (wallet-wide)
- Uses `collect_creator_fee` against legacy creator vault PDA (`creatorVaultPda(creatorPublicKey)`).
- Can return successful tx with no claimed amount if chain reports no creator fee to collect.
- Treat as wallet-level sweep, not mint-targeted accounting.

### E) `claim-mint` (mint-specific)
Mint-specific claim has two operational branches:

1. **Sharing vault path (preferred when sharing vault exists with lamports)**
   - Uses mint + sharing config PDAs.
   - For completed curves, first executes PumpSwap pre-transfer:
     - `transfer_creator_fees_to_pump` on `PUMP_SWAP_PROGRAM_ID`
     - moves/unwraps creator fees from swap-side state into claimable vault flow.
   - Then executes Pump `distribute_creator_fees`.

2. **Legacy fallback path**
   - If sharing vault unavailable/empty, uses `collect_creator_fee` (wallet-wide style).

Safety/reliability behavior:
- Validates PDAs before send.
- Supports `--simulate`.
- Has fallback/retry handling to avoid full hard-fail on partial flow mismatch.

## 5) Launchermap and isolation model

`launcherId` can enforce strict ownership constraints:
- signer wallet must match mapped launcher wallet,
- mint must be included in mapped launcher mint list (if present).

This prevents cross-launcher fee operations from the wrong signer.

## 6) Output contracts (automation-friendly)

Commands print JSON and proof lines.

Examples:
- deploy/deploy2 proof includes tx + mint + creator + fee mode + recipients.
- claim-mint proof includes tx + mint + claimed SOL.

Automations should parse JSON first and use proof lines as secondary audit text.

## 7) RPC and environment

RPC precedence:
1. `RPC_URL` environment variable (preferred)
2. `config.json` (`{ "rpcUrl": "..." }`)

Always verify connectivity before multi-step flows:
```bash
node cli.js check
```

## 8) IPFS metadata: what it is, why it is needed, and how to set it up

Token deploy writes a metadata URI onchain. Social links are not passed directly in the create instruction; they must be inside JSON at that URI.

Use IPFS to host that JSON reliably:
- IPFS = content-addressed storage (`ipfs://<CID>` or gateway URL).
- Needed because Pump metadata expects a stable, fetchable JSON URI.
- If metadata URL is bad or temporary, socials/image may fail to render in explorers/frontends.

Current repo behavior:
- `deploy/deploy2` can auto-upload metadata JSON to Pinata when socials/description/image are provided.
- Gateway URL is built as `https://<PINATA_GATEWAY>/ipfs/<CID>`.

Required env vars (set in `.env` at repo root):
```bash
PINATA_JWT=<pinata-jwt>
PINATA_GATEWAY=<your-gateway-hostname>
```

How to get Pinata credentials:
1. Create/login at Pinata.
2. Create an API key (JWT-enabled / scoped key).
3. Copy JWT to `PINATA_JWT`.
4. Copy your gateway hostname (e.g. `example.mypinata.cloud`) to `PINATA_GATEWAY`.

Deploy with socials (example):
```bash
node cli.js deploy \
  --keyfile <WALLET_JSON> \
  --mintkeyfile <MINT_KEYPAIR_JSON> \
  --name <NAME> --symbol <SYMBOL> \
  --description <TEXT> \
  --twitter <URL> --telegram <URL> --website <URL> \
  --imageUri <IMAGE_URL> \
  --initialBuySol <SOL>
```

If no socials/description/image are provided, pass `--uri <METADATA_URI>` manually.

## 9) Mandatory operational safeguards

- Never commit wallet key JSON files.
- Never log or paste raw private keys.
- Use `--simulate` before high-frequency or cron automation changes.
- When debugging claims, inspect on-chain logs for explicit instruction names:
  - `TransferCreatorFeesToPump`
  - `DistributeCreatorFees`
  - `CollectCreatorFee`
- Distinguish **tx success** from **value movement** (a claim tx can succeed with zero effective claim).

## 10) Known nuanced behavior

- Wallet-wide claim can succeed with `No creator fee to collect` (no-op success).
- Mint-specific claim for completed curves may require PumpSwap pre-transfer before Pump distribute; skipping pre-transfer can produce ghost/no-op claims.
- Account ordering and PDA correctness are strict for Anchor programs; mismatches fail with constraint/account errors.

## 11) Quick debug workflow for claim issues

1. Run simulate first:
```bash
node cli.js claim-mint --keyfile <WALLET_JSON> --mint <MINT> --simulate
```
2. Confirm logs include expected instruction sequence for completed curves.
3. If live tx succeeds but claimed amount is unclear, fetch tx logs and compare pre/post balances for creator and vault accounts.
4. If launcher-scoped, verify `launchermap` wallet/mint mapping before changing claim logic.

## 12) What this skill is NOT

- Not a generic Solana SDK framework.
- Not an on-chain indexer.
- Not a custody/key-management system.

Use it as an execution/debug skill for this repo’s CLI contracts and claim mechanics.