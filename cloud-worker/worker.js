import { paymentInfo } from '../src/constants.js';
import { verifyBasePaymentTx, verifySolanaPaymentTx } from '../src/payments.js';
import { scanSolanaTokenBasic, detectSolanaBlock0Bundler } from '../src/solana-scanner.js';
import { scanBaseTokenBasic, detectBaseEarlyBundlerAndHoneypot } from '../src/base-scanner.js';
import { chainName, solanaAddress, evmAddress } from '../src/rpc.js';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
export async function handleRequest(request, env = {}, injected = {}) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return json({ name: 'cabal-radar-mcp', version: '1.0.0' });
  if (url.pathname !== '/scan') return json({ error: 'NOT_FOUND' }, 404);
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'POST' });
  // Custom receipt-based HTTP 402 flow. Not the x402 exact authorization/settlement wire protocol.
  const txHash = request.headers.get('x-payment-tx'), paymentChain = request.headers.get('x-payment-chain');
  if (!txHash || !paymentChain) return json({ error: 'PAYMENT_REQUIRED', scheme: 'onchain-receipt-v1', payments: paymentInfo(), instructions: 'Retry with X-Payment-Tx and X-Payment-Chain (base or solana). Public receipts are reusable bearer proofs; no payer authentication or per-request settlement.' }, 402, { 'x-payment-required': 'onchain-receipt-v1' });
  try {
    chainName(paymentChain);
    const paymentOptions = { rpcUrl: paymentChain === 'base' ? env.BASE_RPC_URL : env.SOLANA_RPC_URL, ...injected.paymentOptions };
    await (paymentChain === 'base' ? verifyBasePaymentTx : verifySolanaPaymentTx)(txHash, paymentOptions);
  } catch { return json({ error: 'PAYMENT_NOT_VERIFIED' }, 402); }
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) return json({ error: 'JSON_REQUIRED' }, 415);
    const reader = request.body?.getReader(); if (!reader) throw new Error('Body required');
    let size = 0, body = ''; const decoder = new TextDecoder();
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) { await reader.cancel(); return json({ error: 'BODY_TOO_LARGE' }, 413); } body += decoder.decode(value, { stream: true }); }
    body += decoder.decode();
    const args = JSON.parse(body), chain = chainName(args.chain);
    if (Object.keys(args).some(k => !['address','chain'].includes(k))) throw new Error('Only address and chain are accepted');
    (chain === 'base' ? evmAddress : solanaAddress)(args.address);
    const options = { rpcUrl: chain === 'base' ? env.BASE_RPC_URL : env.SOLANA_RPC_URL, ...injected.scanOptions };
    const basic = await (chain === 'base' ? scanBaseTokenBasic : scanSolanaTokenBasic)(args.address, options);
    const deep = await (chain === 'base' ? detectBaseEarlyBundlerAndHoneypot : detectSolanaBlock0Bundler)(args.address, { ...options, basic });
    return json({ basic, deep });
  } catch (e) { return json({ error: e.name === 'RpcError' ? 'UPSTREAM_RPC_FAILURE' : 'INVALID_REQUEST_OR_UNAVAILABLE_DATA' }, e.name === 'RpcError' ? 502 : 400); }
}
export default { fetch: handleRequest };
// Deno Deploy: import { handleRequest } from './worker.js'; Deno.serve(r => handleRequest(r, Deno.env.toObject()));
