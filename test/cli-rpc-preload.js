// Synthetic RPC transport for subprocess tests; no sockets, keys or live payments.
import { basePayment, baseScanRpc } from './fixtures.js';
const payment = basePayment(), scanner = baseScanRpc();
let codeReads = 0;
globalThis.fetch = async (url, options) => {
  if (url !== 'https://rpc.example.test') throw new Error('Unexpected test endpoint');
  const q = JSON.parse(options.body);
  if (q.method === 'eth_getCode' && ++codeReads > 1) throw new Error('Duplicate basic scan in CLI');
  const result = q.method.startsWith('eth_getTransaction') || q.method === 'eth_chainId' ? await payment(q.method, q.params) : await scanner(q.method, q.params);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }), { headers: { 'content-type': 'application/json' } });
};
