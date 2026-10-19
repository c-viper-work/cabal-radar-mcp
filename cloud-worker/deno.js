import { handleRequest } from './worker.js';
Deno.serve(request => handleRequest(request, {
  BASE_RPC_URL: Deno.env.get('BASE_RPC_URL'),
  SOLANA_RPC_URL: Deno.env.get('SOLANA_RPC_URL')
}));
