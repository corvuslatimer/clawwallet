#!/usr/bin/env node

const { verifyInvoicePaid } = require('./verify');
const { getInvoiceIdPDA } = require('./pumpCompat');

function arg(flag, fallback = undefined) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  const mint = arg('--mint');
  const currencyMint = arg('--currency-mint', 'So11111111111111111111111111111111111111112');
  const amount = arg('--amount');
  const memo = arg('--memo');
  const startTime = arg('--start-time');
  const endTime = arg('--end-time');
  const environment = arg('--env', 'mainnet');

  if (!mint || !amount || !memo || !startTime || !endTime) {
    console.error('Missing required args.');
    console.error('Usage: node invoice/test-verify.js --mint <MINT> --amount <u64> --memo <u64> --start-time <i64> --end-time <i64> [--currency-mint <MINT>] [--env mainnet|devnet]');
    process.exit(1);
  }

  const invoiceId = getInvoiceIdPDA({
    mint,
    currencyMint,
    amount,
    memo,
    startTime,
    endTime,
  });

  const out = await verifyInvoicePaid({
    environment,
    invoiceId,
    mint,
    expected: {
      currencyMint,
      amount,
      memo,
      startTime,
      endTime,
    },
  });

  console.log(JSON.stringify({ ok: true, invoiceId, verification: out }, null, 2));
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
