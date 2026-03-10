# Clawwallet Skill

Solana wallet/trading CLI for OpenClaw.

## Entry points

- Primary CLI: `node cli.js`
- Legacy compatibility core (for non-migrated commands): `legacy-core.js`

## Modular layout

- `config/` → network/program constants
- `solana/` → connection, transaction sending, PDA + pump helpers
- `pump/` → concrete Pump flows (`buy.js`, `sell.js`, `deploy.js`, `claim.js`, `feeSharing.js`)
- `launcher/` → launchermap tracking + attribution context
- `utils/` → key parsing, anchor encoding, optional logging

## Migrated commands in `cli.js`

```bash
node cli.js buy --keyfile <WALLET_JSON> --mint <MINT> --sol <AMOUNT> [--slippageBps <BPS>]
node cli.js sell --keyfile <WALLET_JSON> --mint <MINT> --amount <AMOUNT> [--slippageBps <BPS>]
node cli.js deploy --keyfile <WALLET_JSON> --mintkeyfile <MINT_KEYPAIR_JSON> --name <NAME> --symbol <SYMBOL> --uri <METADATA_URI> [--initialBuySol <SOL>] [--slippageBps <BPS>] [--simulate]
node cli.js claim --keyfile <WALLET_JSON>
node cli.js launchermap [list|get|set|add] ...
node cli.js check
node cli.js --help
```

Notes:
- `--slippage` is still accepted as a compatibility alias for buy/sell/deploy.
- Buy uses Jupiter first, then Pump fallback; sell includes pre-bonded Pump + bonded Jupiter paths.

## Legacy passthrough behavior

Commands not yet migrated in `cli.js` still delegate to `legacy-core.js`.

## RPC config

Set RPC via env or local config:

- `RPC_URL` env var (preferred)
- `config.json` with `{ "rpcUrl": "..." }`

## Safety notes

- Keep wallet files in `wallets/` private (never commit keys).
- Use `--simulate` where available before write actions.
