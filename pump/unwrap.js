const { Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, createCloseAccountInstruction } = require('@solana/spl-token');
const { readPrivateKey } = require('../utils/wallet');
const { connection } = require('../solana/connection');

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

async function unwrapWsol({ privateKey, simulate = false } = {}) {
  if (!privateKey) throw new Error('privateKey required');

  const owner = Keypair.fromSecretKey(readPrivateKey(privateKey));
  const wsolAta = await getAssociatedTokenAddress(WSOL_MINT, owner.publicKey, false, TOKEN_PROGRAM_ID);
  const bal = await connection.getTokenAccountBalance(wsolAta).catch(() => null);

  if (!bal || bal.value.amount === '0') {
    return {
      skipped: true,
      reason: 'No WSOL ATA balance to unwrap',
      owner: owner.publicKey.toBase58(),
      wsolAta: wsolAta.toBase58(),
      amountRaw: '0',
      amountUi: '0',
    };
  }

  const tx = new Transaction().add(
    createCloseAccountInstruction(wsolAta, owner.publicKey, owner.publicKey, [], TOKEN_PROGRAM_ID)
  );
  tx.feePayer = owner.publicKey;
  const latest = await connection.getLatestBlockhash('processed');
  tx.recentBlockhash = latest.blockhash;
  tx.sign(owner);

  if (simulate) {
    const sim = await connection.simulateTransaction(tx, [owner], 'processed');
    if (sim.value.err) {
      const err = new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
      err.logs = sim.value.logs || [];
      throw err;
    }
    return {
      simulated: true,
      owner: owner.publicKey.toBase58(),
      wsolAta: wsolAta.toBase58(),
      amountRaw: bal.value.amount,
      amountUi: bal.value.uiAmountString,
      logs: sim.value.logs || [],
    };
  }

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5, preflightCommitment: 'processed' });
  await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');

  return {
    signature: sig,
    tx: sig,
    owner: owner.publicKey.toBase58(),
    wsolAta: wsolAta.toBase58(),
    amountRaw: bal.value.amount,
    amountUi: bal.value.uiAmountString,
  };
}

module.exports = { unwrapWsol };
