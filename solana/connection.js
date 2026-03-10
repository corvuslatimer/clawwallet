const { Connection } = require('@solana/web3.js');
const { RPC_URL } = require('../config/constants');

if (!RPC_URL) throw new Error('Missing RPC_URL (env or config.json)');

const connection = new Connection(RPC_URL, 'confirmed');

module.exports = { connection };
