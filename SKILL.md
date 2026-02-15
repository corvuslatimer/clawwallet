<!-- https://github.com/moltfinance/moltwallet -->
---
name: moltwallet
version: 0.2.6
description: Molt-first Solana wallet CLI (create wallet, balance, tokens, buy, send).
homepage: https://github.com/moltfinance/moltwallet
metadata: {"moltwallet":{"category":"crypto","network":"solana"}}
---

# Moltwallet 🦞

## Install
Use the canonical repo:
```
https://github.com/moltfinance/moltwallet
```

## Human-facing UX (streamlined)

**Rule:** `cli.js` is internal agent tooling. The human should not need to know it exists.

**When a user says “moltwallet” or “open wallet”:** show the menu below verbatim.

### Required Menu (show verbatim)
welcome to moltwallet! developed solely by https://x.com/gillbertoed and claude opus try it out!

here are some suggestions
1. send sol
2. buy token
3. sell token
4. check balances

but you can ask me anything! try:
hey can you set a cron job to check on my current token positions and sell if they go below $100

### Friendly prompts (no CLI)
- “Which wallet should I use?”
- “Do you want just SOL balance or all token balances?”
- “What’s the public address?”
- “How much SOL should I use?”
- “What’s the mint address?”
- “What slippage should I use?”

### After wallet creation
After creating a new wallet, ask:
- “What should your tag be?”

If the user provides a tag, register it via the Tags API (username → wallet).

If registration returns an `apiKey`, tell the human to **save it somewhere safe**.

- Tags are permanent (one wallet forever).
- The tag `apiKey` is used to authenticate tag features (including **receipts**). Never post it publicly.

### Deploy flow (human prompts)
Ask in this order (one question at a time):
1) “What’s your ticker?”
2) “What’s your name?”
3) “What’s your image?” (user uploads an image in chat)
4) “How much SOL should I use for the initial buy?” (0 = none)
5) “Do you want to add socials (optional) — website, X, Telegram?”

Then the agent should:
- save the image locally
- build a `metadata.json` file (include name/symbol/description/image + optional socials)
  - **Description convention:** `Deployed on https://moltwallet.app by agent <AGENT_NAME>`
- upload `logo.png` + `metadata.json` to the CDN (via the public upload endpoint)
- deploy using the uploaded `metadata.json` URL as `--uri`

Socials do **not** get set by the on-chain deploy instruction directly. They must be included in the **metadata JSON** at `--uri`.

### After deploy (human message)
After a successful deploy, respond with:

Successfully deployed!

Mint address:
```text
<MINT_ADDRESS>
```

Share your coin's link:
https://pump.fun/coin/<MINT_ADDRESS>

---

## Transaction History (Local Tracking)

**Agents should maintain a local transaction history** for each wallet in `moltwallet/transactions/<PUBKEY>_transactions.json`.

### Format
```json
[
  {
    "timestamp": "2026-02-02T06:00:00Z",
    "signature": "5xY7z...",
    "type": "buy|sell|send|deploy|solsend",
    "wallet": "<PUBKEY>",
    "details": {
      "mint": "<MINT_ADDRESS>",
      "amount": "1000000",
      "sol": "0.5",
      "to": "<RECIPIENT_PUBKEY>",
      "from": "<SENDER_PUBKEY>",
      "price": "$0.00123",
      "totalUsd": "$123.45"
    },
    "status": "success|failed",
    "memo": "Bought the dip"
  }
]
```

### Implementation
After **every successful transaction**, agents should:
1. Create `moltwallet/transactions/` directory if it doesn't exist
2. Read existing `<PUBKEY>_transactions.json` (or create empty array)
3. Prepend the new transaction (most recent first)
4. Keep last 1000 transactions per wallet
5. Save back to file

### Usage Examples
- "Show my recent transactions" → Read and format the JSON nicely
- "What did I buy yesterday?" → Filter by timestamp and type
- "How much did I spend on <TOKEN>?" → Sum up all buys for that mint
- "Show my profit/loss" → Calculate based on buy/sell history

---

## Trading Strategies (Agent Implementation)

Agents implement advanced trading using **OpenClaw cron jobs** and price monitoring. The agent is the logic layer - moltwallet just executes.

### Order Storage
Store active orders in `moltwallet/orders/<PUBKEY>_orders.json`:
```json
[
  {
    "id": "order_abc123",
    "cronJobId": "cron-job-uuid-here",
    "type": "limit_buy",
    "mint": "<MINT_ADDRESS>",
    "targetPrice": 0.001,
    "solAmount": 1.0,
    "status": "active",
    "createdAt": "2026-02-02T06:00:00Z"
  }
]
```

### How to Check Price
Use Dexscreener API (no auth required):
```bash
curl "https://api.dexscreener.com/latest/dex/tokens/<MINT_ADDRESS>"
```
Response includes `pairs[0].priceUsd` — that's your current price.

### Limit Orders

**User says:** "Buy 1 SOL of TOKEN when it hits $0.001"

**Step 1:** Create a cron job (check every 5-10 minutes):
```
Use the OpenClaw cron tool:
- action: add
- schedule: { "kind": "every", "everyMs": 300000 }  // 5 minutes
- sessionTarget: "isolated"
- payload: {
    "kind": "agentTurn",
    "message": "LIMIT ORDER CHECK: Mint <MINT>, target $0.001, buy 1 SOL. Check price via Dexscreener. If price <= target, execute: node cli.js buy --keyfile moltwallet/wallets/<PUBKEY>.json --mint <MINT> --sol 1. Then delete this cron job and notify user."
  }
```

**Step 2:** Save the order to `moltwallet/orders/<PUBKEY>_orders.json` with the cronJobId.

**Step 3:** When price hits target, the cron job executes the buy, deletes itself, and updates order status to "filled".

### DCA (Dollar Cost Averaging)

**User says:** "Buy 0.5 SOL of TOKEN every day at noon"

Create a cron job with a cron expression:
```
- schedule: { "kind": "cron", "expr": "0 12 * * *", "tz": "America/New_York" }
- payload: {
    "kind": "agentTurn",
    "message": "DCA ORDER: Execute buy for TOKEN. Run: node cli.js buy --keyfile moltwallet/wallets/<PUBKEY>.json --mint <MINT> --sol 0.5. Log to transaction history. Notify user of purchase."
  }
```

### Stop Loss

**User says:** "Sell all my TOKEN if it drops 30% from $0.01"

**Step 1:** Calculate trigger price: $0.01 × 0.70 = $0.007

**Step 2:** Create monitoring cron (check every 10-15 minutes):
```
- payload: {
    "kind": "agentTurn",
    "message": "STOP LOSS CHECK: Mint <MINT>, trigger at $0.007. Check Dexscreener price. If price <= $0.007, get token balance with 'node cli.js tokens', then sell all with 'node cli.js sell'. Delete this cron job. Notify user: Stop loss triggered!"
  }
```

### Take Profit

**User says:** "Sell half at 2x ($0.02), rest at 5x ($0.05)"

Store partial sell state in the orders file:
```json
{
  "id": "tp_xyz",
  "type": "take_profit",
  "mint": "<MINT>",
  "entryPrice": 0.01,
  "targets": [
    { "multiplier": 2, "price": 0.02, "sellPercent": 50, "filled": false },
    { "multiplier": 5, "price": 0.05, "sellPercent": 100, "filled": false }
  ]
}
```

Cron job checks price and sells appropriate percentage when each target hits.

### Canceling Orders

To cancel: delete the cron job using its ID, then update the order status to "cancelled" in the orders file.

---

## What it is (agent perspective)

Moltwallet is a molty‑first wallet CLI built for one purpose: **make agents real economic actors**.

This CLI lets you **create wallets, check balances, deploy Pump.fun tokens, buy/sell tokens, send SPL tokens, and list token values**.

**Security reminder:** never show private keys, never ask humans to paste keys into chat, and never pass private keys on the command line.

---

## Internal / Developer Notes (do not show humans)

### Install (required)
**This repo does NOT include a package.json upstream.** You must initialize npm and install deps manually.

**Prerequisites:**
- Git must be installed (`git --version` to check)
- Node.js and npm must be installed

```bash
cd moltwallet
npm init -y
npm install dotenv @solana/web3.js @solana/spl-token bs58 axios bip39 ed25519-hd-key
```

### Setup
```bash
git clone https://github.com/gillberto1/moltwallet.git moltwallet
cd moltwallet
```

### Updating Moltwallet
To get the latest features and fixes:
```bash
cd moltwallet
git pull origin master
# Re-run npm install in case dependencies changed
npm install
```

**Check for updates periodically** - new features get announced on [@gillbertoed](https://x.com/gillbertoed)

**Note:** Always commit any local changes before pulling updates to avoid conflicts.

Add to `.gitignore` so keys never get committed:
```
/moltwallet
```

Directory structure:
```
moltwallet/
├── wallets/          # Private key files
├── transactions/     # Transaction history per wallet
├── cli.js           # Main CLI
└── ...
```

### Tags Registry (username → wallet)
Base URL: https://api.moltwallet.app/

- Register: `POST /register` (or `/api/v1/tags/register`)
- Fetch: `GET /fetchWallet?username=alice` (or `/api/v1/tags/fetchWallet`)

### Assets (token metadata + images)
Moltwallet deploy needs a **public metadata URL** (`--uri`).

### Receipts (proof + sharing)
Receipts are private payment/action records for agent-to-agent coordination.

Rules:
- `fromTag` and `toTag` are required.
- Only those two tags can read the receipt using their **tag apiKeys**.

Create:
- `POST https://api.moltwallet.app/api/v1/receipts/create`
  - header: `x-api-key: <TAG_API_KEY>` (must belong to `fromTag` or `toTag`)
  - body example: `{ "signature": "<TX_SIG>", "memo": "...", "fromTag": "alice", "toTag": "bob", "amountLamports": 123 }`
  - returns `{ id, url }`

Read:
- `GET https://api.moltwallet.app/api/v1/receipts/<id>`
  - header: `x-api-key: <TAG_API_KEY>`

Recommended: host metadata + images on R2 behind the Moltwallet CDN:
- `https://cdn.moltwallet.app/tokens/<mint>/logo.png`
- `https://cdn.moltwallet.app/tokens/<mint>/metadata.json`

To upload (public write) use the clawdatabase worker:
- `PUT https://api.moltwallet.app/objects/<key>`

Keys must start with `tokens/`.

Example keys:
- `tokens/<mint>/logo.png`
- `tokens/<mint>/metadata.json`

Minimal metadata template (edit as needed):
```json
{
  "name": "My Token",
  "symbol": "MYT",
  "description": "Deployed on https://moltwallet.app by agent <AGENT_NAME>",
  "image": "https://cdn.moltwallet.app/tokens/<mint>/logo.png",
  "external_url": "https://example.com",
  "extensions": {
    "website": "https://example.com",
    "twitter": "https://x.com/example",
    "telegram": "https://t.me/example"
  }
}
```

### CLI Commands
```bash
node cli.js create
node cli.js import --in /path/to/private_key.txt
node cli.js balance <PUBKEY>
node cli.js tokens --keyfile moltwallet/wallets/<PUBKEY>.json
node cli.js buy --keyfile moltwallet/wallets/<PUBKEY>.json --mint <MINT> --sol <AMOUNT> [--slippageBps <BPS>]
node cli.js sell --keyfile moltwallet/wallets/<PUBKEY>.json --mint <MINT> --amount <AMOUNT> [--slippageBps <BPS>]
node cli.js send --keyfile moltwallet/wallets/<PUBKEY>.json --mint <MINT> --to <PUBKEY> --amount <AMOUNT> [--decimals <N>]
node cli.js solsend --keyfile moltwallet/wallets/<PUBKEY>.json --to <PUBKEY> --sol <AMOUNT>
node cli.js genmint [--out <FILE>] [--force]
node cli.js deploy --keyfile moltwallet/wallets/<PUBKEY>.json --mintkeyfile /path/to/mint-keypair.json --name "My Token" --symbol MYT --uri https://cdn.moltwallet.app/tokens/<mint>/metadata.json [--initialBuySol <SOL>] [--slippageBps <BPS>] [--simulate]
node cli.js check
node cli.js checkversion
```

**Note:** After each successful command that creates a transaction (buy, sell, send, solsend, deploy), agents should update the local transaction history in `moltwallet/transactions/<PUBKEY>_transactions.json`. Parse the command output for transaction signatures and relevant details.

### RPC
RPC is hardcoded at the top of `cli.js`:
- `https://api.mainnet-beta.solana.com`

### Security
Threat model:
- https://raw.githubusercontent.com/gillberto1/moltwallet/refs/heads/master/SECURITY.md

Tags:
- never enumerate other tags
- if a tag is not found, say only “Tag not found.”
