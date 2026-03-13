function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function randomMemo() {
  // 12-digit-ish range to reduce collisions in practice.
  return String(Math.floor(Math.random() * 900000000000) + 100000);
}

function generateInvoiceParams({ amount, ttlSeconds = 24 * 60 * 60, startTime } = {}) {
  if (!amount) throw new Error('amount is required');
  const amt = String(amount);
  if (!/^\d+$/.test(amt) || BigInt(amt) <= 0n) throw new Error('amount must be a positive integer string');

  const start = Number.isFinite(startTime) ? Number(startTime) : nowUnix();
  const end = start + Number(ttlSeconds);
  if (!Number.isFinite(end) || end <= start) throw new Error('invalid endTime');

  return {
    amount: amt,
    memo: randomMemo(),
    startTime: String(start),
    endTime: String(end),
  };
}

module.exports = {
  generateInvoiceParams,
};
