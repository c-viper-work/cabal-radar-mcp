export const EVM_RECIPIENT = '0x3018577736ebcdd3ddca916Bef44e7dC6E27e33E';
export const SOLANA_RECIPIENT = 'HFBvBikfatVJgZFyisHTatMdQEJHnJRC1a31fJhoNmGR';
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const MIN_USDC = 15_000_000n;
export const MIN_ETH = 6_000_000_000_000_000n;
export const MIN_SOL = 100_000_000n;
export const BASE_RPC_URL = 'https://mainnet.base.org';
export const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
export const BASE_CHAIN_ID = '0x2105';
export const SOLANA_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
// Official snapshot: https://docs.jito.wtf/lowlatencytxnsend/#gettipaccounts
export const JITO_TIP_ACCOUNTS = Object.freeze([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
]);
export function paymentInfo() {
  return { base: { chainId: 8453, recipient: EVM_RECIPIENT, usdc: { contract: BASE_USDC, decimals: 6, minimum: '15000000', display: '15 USDC' }, eth: { minimum: MIN_ETH.toString(), display: '0.006 ETH' } }, solana: { network: 'mainnet-beta', recipient: SOLANA_RECIPIENT, usdc: { mint: SOLANA_USDC, decimals: 6, minimum: MIN_USDC.toString(), display: '15 USDC' }, sol: { minimum: MIN_SOL.toString(), display: '0.1 SOL' } } };
}
