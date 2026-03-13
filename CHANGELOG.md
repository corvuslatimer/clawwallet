# Changelog

All notable changes to this project are documented here.

## 2026-03-13

### Added
- **Full modular revamp** across CLI + `pump/` + `solana/` structure for clearer separation of concerns and safer iteration.

- **Metadata upload during deploy** with socials support.
  - New optional deploy/deploy2 params:
    - `--description`
    - `--twitter`
    - `--telegram`
    - `--website`
    - `--imageUri`
  - If socials/description/image are provided, metadata JSON is uploaded automatically and the resulting `metadataUri` is used in on-chain create.
  - Deploy output now includes `metadataUri`.

- **Pinata metadata backend integration** (current default).
  - Added support for:
    - `PINATA_JWT`
    - `PINATA_GATEWAY`
  - Metadata URIs are emitted as:
    - `https://<PINATA_GATEWAY>/ipfs/<CID>`

- **PumpSwap liquidity scripts** (initial working implementation for CoPR pool flow):
  - `pumpswap/addLiquidity.js`
  - `pumpswap/removeLiquidity.js`
  - Successfully tested against live transactions for CoPR pool/account mapping.

- **Fee redirect split support** in `pump/feeSharing.js`.
  - `fee-redirect` is no longer 100% only.
  - `--bps <1..10000>` now supports partial split:
    - recipient gets `bps`
    - signer keeps `10000 - bps`

### Changed
- **Buy/sell flow reliability improved for both curve states**:
  - Buying now works for both bonded (active curve) and non-bonded/graduated routes.
  - Selling now works for both bonded (active curve) and non-bonded/graduated routes.

- **Deployment flow hardened and fixed**:
  - Single-tx create+buy flow validated in live runs.
  - Metadata handling corrected and integrated with upload-backed URIs.

- **Fee redirect flow fixed and verified**:
  - Redirect now executes reliably, including partial split behavior.

- **RPC config moved to environment-only.**
  - `config/constants.js` now requires `RPC_URL` from env / `.env`.
  - Removed runtime dependency on `config.json` fallback.

- **CLI usage/help updated** for deploy/deploy2 to reflect optional metadata URI and socials fields.


### Fixes
- Token mint metadata reads now handle Token-2022/legacy mint program fallback where needed.
- Corrected several account/program assumptions during PumpSwap liquidity simulation/debug flow.
- Resolved slippage failures in add-liquidity flow by using correct Deposit arg shape (`lp_token_amount_out`, `max_base_amount_in`, `max_quote_amount_in`) and calibrated max inputs.

### Notes
- Current PumpSwap liquidity scripts are **working for the known CoPR pool mapping** used in live tests.
- Generalized multi-mint pool discovery/derivation is still pending hardening.
- Pinata JWT was provided in-session; rotate credentials if needed.
