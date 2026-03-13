const MAINNET_BASE = 'https://fun-block.pump.fun';
const DEVNET_BASE = 'https://blockchain-client.internal.pump.fun';

function getBase(environment = 'mainnet') {
  return environment === 'devnet' ? DEVNET_BASE : MAINNET_BASE;
}

function toStringSafe(v) {
  return v === undefined || v === null ? '' : String(v);
}

async function verifyInvoicePaid({ environment = 'mainnet', invoiceId, mint, expected, rpcFallback } = {}) {
  if (!invoiceId) throw new Error('invoiceId is required');
  if (!mint) throw new Error('mint is required');

  const base = getBase(environment);
  const url = new URL('/agents/invoice-id', base);
  url.searchParams.set('invoice-id', invoiceId);
  url.searchParams.set('mint', mint);

  try {
    const res = await fetch(url.toString());
    if (res.ok) {
      const data = await res.json();

      // If expected values are provided, enforce strict match.
      if (expected) {
        const ok =
          (!expected.user || toStringSafe(data.user) === toStringSafe(expected.user)) &&
          (!expected.currencyMint || toStringSafe(data.currency_mint) === toStringSafe(expected.currencyMint)) &&
          (!expected.amount || toStringSafe(data.amount) === toStringSafe(expected.amount)) &&
          (!expected.memo || toStringSafe(data.memo) === toStringSafe(expected.memo)) &&
          (!expected.startTime || toStringSafe(data.start_time) === toStringSafe(expected.startTime)) &&
          (!expected.endTime || toStringSafe(data.end_time) === toStringSafe(expected.endTime));

        if (ok) return { paid: true, source: 'pump-api', data };
      } else {
        return { paid: true, source: 'pump-api', data };
      }
    }
  } catch (err) {
    // fall through to fallback
  }

  if (typeof rpcFallback === 'function') {
    const paid = await rpcFallback();
    return { paid: Boolean(paid), source: 'rpc-fallback' };
  }

  return { paid: false, source: 'none' };
}

module.exports = {
  verifyInvoicePaid,
  getBase,
};
