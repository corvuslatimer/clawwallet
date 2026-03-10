const { Transaction, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { connection } = require('./connection');
const { PRIORITY_FEE_SOL } = require('../config/constants');

function computeUnitPriceMicrolamports(unitLimit) {
  const feeLamports = Math.floor(PRIORITY_FEE_SOL * LAMPORTS_PER_SOL);
  return Math.max(0, Math.floor((feeLamports * 1_000_000) / unitLimit));
}

async function sendTx(tx, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  if (tx instanceof Transaction) {
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(...signers);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  }

  if (tx instanceof VersionedTransaction) {
    tx.message.recentBlockhash = blockhash;
    tx.sign(signers);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  }

  throw new Error('Unsupported transaction type');
}

module.exports = { sendTx, computeUnitPriceMicrolamports };
