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

export const KNOWN_SOLANA_POOLS_AND_PROGRAMS = Object.freeze([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5duoVn5Ua',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, '11111111111111111111111111111111'
]);
export const KNOWN_SOLANA_EXCHANGE_WALLETS = Object.freeze([
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',
  '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD', 'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2'
]);
export const KNOWN_BASE_ROUTERS_AND_POOLS = Object.freeze([
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', '0x2626664c2603336e57b271c5c0b26f421741e481',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', '0x6ff5693b99212da76ad316178a184ab56d299b43',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', '0x4200000000000000000000000000000000000010'
]);
