require('dotenv').config({ quiet: true });
const { PublicKey } = require('@solana/web3.js');

// RPC configuration: env only
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  throw new Error('RPC_URL missing. Set it in environment/.env');
}

const PUMP_SWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP_SWAP_GLOBAL_CONFIG = PublicKey.findProgramAddressSync(
  [Buffer.from('global')],
  PUMP_SWAP_PROGRAM_ID
)[0];
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
const PRIORITY_FEE_SOL = 0.0001;

module.exports = {
  RPC_URL,
  PRIORITY_FEE_SOL,
  PUMP_SWAP_PROGRAM_ID,
  PUMP_SWAP_GLOBAL_CONFIG,
  PUMP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  PUMP_FEE_RECIPIENT,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  SYSVAR_RENT,
};