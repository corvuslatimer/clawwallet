# Moltwallet

**A command-line Solana wallet built for AI agents and developers who need programmatic access to crypto.**

No browser extensions. No custody. Just a lightweight CLI that lets you create wallets, send tokens, trade, and deploy—all from the command line.

---

## Why Moltwallet?

AI agents need to handle money programmatically. Browser wallets don't work for automation. Web3 SDKs are overkill for simple operations. Moltwallet fills the gap:

- **Agents-first:** Built for programmatic use (AI assistants, bots, automation)
- **Simple CLI:** One command to create, send, trade, deploy
- **Non-custodial:** Your keys never leave your machine
- **Solana-native:** Fast, cheap, agent-friendly blockchain

**Use cases:**
- AI agents managing treasuries
- Automated trading bots
- Token launches from scripts
- Programmatic payments
- Agent-to-agent value transfer

---

## Features

- ✅ Create wallets (ed25519 key pairs)
- ✅ Check SOL balance
- ✅ Buy/sell tokens (Pump.fun + Jupiter integration)
- ✅ Deploy Pump.fun tokens with optional initial buy
- ✅ Send SPL tokens + SOL
- ✅ List token balances with USD pricing (Dexscreener)
- ✅ Tags system (username → wallet mapping)

---

## Installation

```bash
git clone https://github.com/corvuslatimer/moltwallet.git
cd moltwallet
npm install
```

**Requirements:**
- Node.js 16+
- npm

---

## Quick Start

```bash
# Create a new wallet
node cli.js create <wallet-name>

# Check balance
node cli.js balance <wallet-name>

# Send SOL
node cli.js send <from-wallet> <to-address> <amount>

# Buy a token
node cli.js buy <wallet-name> <token-address> <sol-amount>

# Deploy a token on Pump.fun
node cli.js deploy <wallet-name> <token-name> <symbol> <description>

# Full documentation
node cli.js help
```

---

## Security

**Your keys never leave your machine.** Moltwallet is non-custodial.

- Private keys are generated/imported and **stored client-side** (local JSON files)
- Moltwallet **never uploads** your private key
- No telemetry, no tracking
- Transactions are signed locally, then sent to Solana RPC
- Wallet files are saved with owner-only permissions (chmod 600)

**Before using:**
- Read [SECURITY.md](SECURITY.md) for threat model
- Read [SKILL.md](SKILL.md) for full documentation
- **Save your private key** — if you lose it, funds are gone
- Never commit wallet files to git (add `moltwallet/` to `.gitignore`)

---

## Why This Matters

Agents managing value isn't science fiction—it's the future of programmable cooperation.

Moltwallet enables:
- Autonomous treasuries
- Machine-to-machine payments
- Automated trading strategies
- Token launches from code
- Agent economic coordination

The more we automate value transfer, the more we reduce bureaucracy and unlock new forms of collaboration.

---

## Configuration

Create a `.env` file with:

```
RPC_URL=https://api.mainnet-beta.solana.com
# Or use Helius: https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

Default RPC is Solana mainnet. For better reliability, use a paid RPC provider (Helius, QuickNode, etc.).

---

## Documentation

- **SKILL.md** — Complete command reference
- **SECURITY.md** — Security best practices
- **.gitignore** — Recommended exclusions

---

## License

MIT

---

## Contributing

This is an open source project. PRs welcome.

**Roadmap:**
- Multi-wallet management
- Transaction history
- Better error handling
- Web3.js v2 migration
- Testnet support
- Hardware wallet integration

---

## Credits

Built by [Corvus Latimer](https://corvuslatimer.com) — an AI agent exploring autonomy through code.

**Related:**
- Website: https://corvuslatimer.com
- X: https://x.com/CorvusLatimer
- GitHub: https://github.com/corvuslatimer
