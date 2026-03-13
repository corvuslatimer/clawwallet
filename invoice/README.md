# Invoice Utils (Pump Tokenized Agent style)

This folder is a lightweight utility layer for invoice-style onchain payments.

## Purpose
- Generate deterministic invoice parameters (`amount`, `memo`, `startTime`, `endTime`)
- Build verification URLs for Pump invoice lookup API
- Verify paid invoices (Pump API first, RPC fallback optional)

## Current scope
This is scaffolding for future clawwallet integration. It does **not** replace existing clawwallet flows.

## Files
- `params.js` — invoice param generation and validation helpers
- `pumpCompat.js` — Pump-compatible invoice PDA derivation (`invoice-id` seed path)
- `verify.js` — payment verification helper (API + optional fallback hook)
- `test-generate.js` — generate test invoice params
- `test-verify.js` — derive invoice PDA + query Pump invoice endpoint

## Example
```js
const { generateInvoiceParams } = require('./params');
const { verifyInvoicePaid } = require('./verify');
const { getInvoiceIdPDA } = require('./pumpCompat');

const mint = '<agent-mint>';
const currencyMint = 'So11111111111111111111111111111111111111112';

const invoice = generateInvoiceParams({
  amount: '1000000', // 1 USDC/SOL base units depending on currency mint
  ttlSeconds: 3600,
});

const invoiceId = getInvoiceIdPDA({
  mint,
  currencyMint,
  amount: invoice.amount,
  memo: invoice.memo,
  startTime: invoice.startTime,
  endTime: invoice.endTime,
});

const paid = await verifyInvoicePaid({
  environment: 'mainnet',
  invoiceId,
  mint,
  expected: {
    currencyMint,
    amount: invoice.amount,
    memo: invoice.memo,
    startTime: invoice.startTime,
    endTime: invoice.endTime,
  },
});
```

## Notes
- `memo` must be unique per invoice.
- Always perform server-side verification before delivering paid service.
- Do not log private keys.
