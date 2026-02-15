# Clawwallet Skill

**A Solana wallet CLI for OpenClaw agents. Non-custodial programmatic crypto access.**

---

## Installation

```bash
cd /root/.openclaw/workspace
git clone https://github.com/corvuslatimer/clawwallet.git
cd clawwallet
npm install
```

**Add to your workspace context** so other agents can use it.

---

## Core Operations

All commands use `node cli.js <command>` format. Wallet files are stored in `clawwallet/wallets/`.

### Create Wallet

```bash
node cli.js create <wallet-name>
```

Creates a new ed25519 wallet. Returns public key and saves private key to `clawwallet/wallets/<pubkey>.json`.

**⚠️ Save the private key!** If you lose it, funds are gone forever.

### Check Balance

```bash
# SOL balance only
node cli.js balance <wallet-name>

# All token balances with USD pricing
node cli.js balances <wallet-name>
```

### Send SOL

```bash
node cli.js send <from-wallet> <to-address> <amount-sol>
```

Example:
```bash
node cli.js send my-wallet hgof84NNrXzQzxPTKhixokrkPtreMFs4gXzXeFgUK5j 0.1
```

### Send SPL Tokens

```bash
node cli.js sendspl <from-wallet> <to-address> <mint-address> <amount>
```

### Buy Token (Jupiter)

```bash
node cli.js buy <wallet-name> <token-mint-address> <sol-amount>
```

Uses Jupiter aggregator for best price. Default slippage: 10%.

### Sell Token (Jupiter)

```bash
node cli.js sell <wallet-name> <token-mint-address> <percentage>
```

Sells a percentage of your token holdings (1-100).

### Deploy Token (Pump.fun)

```bash
node cli.js deploy <wallet-name> <name> <symbol> <description> [--image <path>] [--initial-buy <sol>]
```

Example:
```bash
node cli.js deploy my-wallet "Claw Coin" "CLAW" "A token for agents" --image logo.png --initial-buy 0.5
```

---

## Configuration

Create `.env` file in clawwallet directory:

```
RPC_URL=https://api.mainnet-beta.solana.com
```

For better reliability, use Helius or QuickNode:
```
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

---

## Security

**Keys never leave your machine.** Clawwallet is non-custodial.

- Private keys stored in `clawwallet/wallets/*.json`
- Files are chmod 600 (owner-only)
- Never commit wallet files to git
- Add `clawwallet/wallets/` to `.gitignore`

**Best practices:**
- Use separate wallets for testing vs production
- Keep private keys backed up securely
- Never share private keys in prompts or logs
- Verify recipient addresses before sending

---

## Usage Patterns for Agents

### Agent Treasury Management

```bash
# Check treasury balance
node cli.js balance treasury

# Send payment to collaborator
node cli.js send treasury <recipient> 1.5

# Buy project token
node cli.js buy treasury <mint> 2.0
```

### Automated Trading

```bash
# Check position
node cli.js balances trading-wallet

# Sell if profit target hit
node cli.js sell trading-wallet <mint> 100
```

### Token Launches

```bash
# Deploy with initial liquidity
node cli.js deploy launch-wallet "Agent Token" "AGT" "Built by AI" --initial-buy 5.0

# Track launch wallet balance
node cli.js balance launch-wallet
```

---

## Error Handling

Common issues:

**"Insufficient funds"**
- Check balance: `node cli.js balance <wallet>`
- Ensure you have SOL for gas fees

**"RPC connection failed"**
- Check `.env` has valid `RPC_URL`
- Try switching to Helius/QuickNode
- Check network connectivity

**"Wallet not found"**
- List wallets: `ls clawwallet/wallets/`
- Create new wallet: `node cli.js create <name>`

**"Transaction timeout"**
- Solana network congestion
- Retry with higher priority fees
- Check RPC provider status

---

## Transaction Tracking

Clawwallet saves transaction signatures. Check them on:
- **Solscan:** https://solscan.io/tx/<signature>
- **Solana Explorer:** https://explorer.solana.com/tx/<signature>

---

## Advanced Features

### Tags (username → wallet mapping)

Register a username that maps to your wallet address:

```bash
node cli.js tag register <wallet-name> <username>
```

Look up a wallet by tag:

```bash
node cli.js tag lookup <username>
```

Tags are permanent and stored on the clawwallet API.

### Import Existing Wallet

```bash
node cli.js import <wallet-name> <base58-private-key>
```

**⚠️ Never paste private keys in chat logs!** Import from secure storage only.

---

## Roadmap

- [ ] Multi-wallet dashboard
- [ ] Transaction history export
- [ ] Portfolio tracking
- [ ] Automated rebalancing
- [ ] Hardware wallet support
- [ ] Testnet mode

---

## Support

- **GitHub:** https://github.com/corvuslatimer/clawwallet
- **Issues:** https://github.com/corvuslatimer/clawwallet/issues
- **Security:** See SECURITY.md

---

## License

MIT - See LICENSE file

Built by Corvus Latimer for the OpenClaw ecosystem.
