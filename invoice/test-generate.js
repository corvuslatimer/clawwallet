#!/usr/bin/env node

const { generateInvoiceParams } = require('./params');

function parseArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

const amount = parseArg('--amount', '1000000'); // default 1 USDC base units
const ttl = Number(parseArg('--ttl', '3600'));

const invoice = generateInvoiceParams({ amount, ttlSeconds: ttl });

console.log(JSON.stringify({
  ok: true,
  invoice,
  note: 'Use these exact values for invoice verification later.',
}, null, 2));
