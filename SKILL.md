# Clawwallet Skill

Solana wallet/trading CLI for OpenClaw.

## Entry point

- Primary CLI: `node cli.js`
- `legacy-core.js` is retired/disabled.

## Modular layout

- `config/` → network/program constants
- `solana/` → connection, transaction sending, PDA + pump helpers
- `pump/` → Pump flows (`buy.js`, `sell.js`, `deploy.js`, `claim.js`, `feeSharing.js`)
- `launcher/` → launchermap tracking + launcher wallet isolation
- `utils/` → key parsing, anchor encoding, optional logging

## Commands

```bash
node cli.js buy --keyfile <WALLET_JSON> --mint <MINT> --sol <AMOUNT> [--slippageBps <BPS>]
node cli.js sell --keyfile <WALLET_JSON> --mint <MINT> --amount <AMOUNT> [--slippageBps <BPS>]
node cli.js deploy --keyfile <WALLET_JSON> --mintkeyfile <MINT_KEYPAIR_JSON> --name <NAME> --symbol <SYMBOL> --uri <METADATA_URI> [--initialBuySol <SOL>] [--slippageBps <BPS>] [--simulate]
node cli.js deploy2 --keyfile <WALLET_JSON> --mintkeyfile <MINT_KEYPAIR_JSON> --name <NAME> --symbol <SYMBOL> --uri <METADATA_URI> --recipients <w1,w2> --bps <8000,2000> [--initialBuySol <SOL>] [--slippageBps <BPS>] [--launcherId <ID>] [--simulate]
node cli.js claim --keyfile <WALLET_JSON>
node cli.js claim-mint --keyfile <WALLET_JSON> --mint <MINT> [--launcherId <ID>] [--simulate]
node cli.js launchermap [list|get|set|add] ...
node cli.js check
node cli.js --help
```

## Integration guarantees

- Deploy path uses `create_v2` and fee sharing (`sharing_config` + `creator_vault`).
- Claim-mint calls `distribute_creator_fees` first, then falls back to vault-delta attribution.
- Launcher wallet isolation is enforced via `launcher/launchermap.json` for launcher-scoped deploy2/claim-mint.
- PDAs are validated before transactions are sent.
- `--simulate` is supported for both `deploy2` and `claim-mint`.
- Proof lines are printed:
  - Deploy: `tx, mint, creator, fee_mode, recipients`
  - Claim: `tx, mint, claimed SOL`

## RPC config

Set RPC via env or local config:

- `RPC_URL` env var (preferred)
- `config.json` with `{ "rpcUrl": "..." }`

## Safety notes

- Keep wallet files in `wallets/` private (never commit keys).
- Use `--simulate` before write actions.
