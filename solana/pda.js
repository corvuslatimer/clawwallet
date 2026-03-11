const { PublicKey } = require('@solana/web3.js');
const {
  PUMP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  PUMP_SWAP_PROGRAM_ID,
  PUMP_SWAP_GLOBAL_CONFIG,
} = require('../config/constants');

const PUMP_GLOBAL = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM_ID)[0];
const PUMP_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_PROGRAM_ID)[0];
const PUMP_GLOBAL_VOLUME_ACCUMULATOR = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM_ID)[0];
const PUMP_FEE_CONFIG = PublicKey.findProgramAddressSync([Buffer.from('fee_config'), PUMP_PROGRAM_ID.toBuffer()], PUMP_FEE_PROGRAM_ID)[0];

function bondingCurvePda(mintPk) {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mintPk.toBuffer()], PUMP_PROGRAM_ID)[0];
}
function mintAuthorityPda() {
  return PublicKey.findProgramAddressSync([Buffer.from('mint-authority')], PUMP_PROGRAM_ID)[0];
}
function metadataPda(mintPk) {
  return PublicKey.findProgramAddressSync([Buffer.from('metadata'), MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()], MPL_TOKEN_METADATA_PROGRAM_ID)[0];
}
function creatorVaultPda(authority) {
  return PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), authority.toBuffer()], PUMP_PROGRAM_ID)[0];
}
function userVolumeAccumulatorPda(user) {
  return PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_PROGRAM_ID)[0];
}
function bondingCurveV2Pda(mintPk) {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve-v2'), mintPk.toBuffer()], PUMP_PROGRAM_ID)[0];
}
function sharingConfigPda(mintPk) {
  return PublicKey.findProgramAddressSync([Buffer.from('sharing-config'), mintPk.toBuffer()], PUMP_FEE_PROGRAM_ID)[0];
}

module.exports = {
  PUMP_GLOBAL,
  PUMP_EVENT_AUTHORITY,
  PUMP_GLOBAL_VOLUME_ACCUMULATOR,
  PUMP_FEE_CONFIG,
  PUMP_SWAP_PROGRAM_ID,
  PUMP_SWAP_GLOBAL_CONFIG,
  bondingCurvePda,
  mintAuthorityPda,
  metadataPda,
  creatorVaultPda,
  userVolumeAccumulatorPda,
  bondingCurveV2Pda,
  sharingConfigPda,
};