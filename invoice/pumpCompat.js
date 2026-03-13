const { PublicKey } = require('@solana/web3.js');

// Pump agent-payments program id from SDK/IDL
const PUMP_AGENT_PAYMENTS_PROGRAM_ID = new PublicKey('AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7');

function u64LE(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function i64LE(v) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
}

function getInvoiceIdPDA({ mint, currencyMint, amount, memo, startTime, endTime }) {
  const mintPk = new PublicKey(mint);
  const currencyPk = new PublicKey(currencyMint);

  const [invoiceId] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('invoice-id'),
      mintPk.toBuffer(),
      currencyPk.toBuffer(),
      u64LE(amount),
      u64LE(memo),
      i64LE(startTime),
      i64LE(endTime),
    ],
    PUMP_AGENT_PAYMENTS_PROGRAM_ID
  );

  return invoiceId.toBase58();
}

module.exports = {
  PUMP_AGENT_PAYMENTS_PROGRAM_ID: PUMP_AGENT_PAYMENTS_PROGRAM_ID.toBase58(),
  getInvoiceIdPDA,
};
