const fs = require('fs');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const bs58raw = require('bs58');
const bs58 = bs58raw.default || bs58raw;

function readPrivateKey(input) {
  if (!input) throw new Error('Missing private key input');
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input instanceof Uint8Array) return input;

  const trimmed = String(input).trim();
  if (trimmed.startsWith('[')) return Uint8Array.from(JSON.parse(trimmed));
  return bs58.decode(trimmed);
}

function getPrivateKeyFromFile(filePath) {
  const p = path.resolve(filePath);
  const raw = fs.readFileSync(p, 'utf8').trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return readPrivateKey(parsed);
    if (parsed && parsed.privateKey) return readPrivateKey(parsed.privateKey);
    if (parsed && Array.isArray(parsed.secretKey)) return Uint8Array.from(parsed.secretKey);
  } catch (_) {}
  return readPrivateKey(raw);
}

function keypairFromPrivateKey(pk) {
  return Keypair.fromSecretKey(readPrivateKey(pk));
}

function getKeypairFromFile(filePath) {
  return keypairFromPrivateKey(getPrivateKeyFromFile(filePath));
}

module.exports = { readPrivateKey, getPrivateKeyFromFile, keypairFromPrivateKey, getKeypairFromFile };
