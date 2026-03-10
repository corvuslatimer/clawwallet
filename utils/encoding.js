const crypto = require('crypto');

function anchorDisc(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function encodeOptionBool(v) {
  if (v === null || v === undefined) return Buffer.from([0]);
  return Buffer.from([1, v ? 1 : 0]);
}

function hashIndex(buf, mod) {
  const h = crypto.createHash('sha256').update(buf).digest();
  const n = h.readUInt32LE(0);
  return mod <= 0 ? 0 : (n % mod);
}

module.exports = { anchorDisc, encodeOptionBool, hashIndex };