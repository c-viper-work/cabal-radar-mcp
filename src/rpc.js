import { BASE_RPC_URL, SOLANA_RPC_URL } from './constants.js';
export class RpcError extends Error {
  constructor(message, code) { super(message); this.name = 'RpcError'; this.code = code; this.isRevert = code === 3 || /execution reverted|vm execution error|\brevert\b/i.test(message); }
}
export function rpcClient(chain, options = {}) {
  if (options.rpc) return async (...args) => { options.signal?.throwIfAborted(); return options.rpc(...args); };
  const url = options.rpcUrl || (chain === 'base' ? BASE_RPC_URL : SOLANA_RPC_URL);
  let id = 0;
  return async (method, params = []) => {
    const requestId = ++id;
    let response;
    try {
      response = await (options.fetch || globalThis.fetch)(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs || 15000), ...(options.signal ? [options.signal] : [])]), redirect: 'error'
      });
    } catch { throw new RpcError(`RPC ${method}: network failure or timeout`); }
    if (!response.ok) throw new RpcError(`RPC ${method}: HTTP ${response.status}`);
    let data;
    try { data = await response.json(); } catch { throw new RpcError(`RPC ${method}: invalid JSON`); }
    if (data.id !== requestId || data.jsonrpc !== '2.0') throw new RpcError(`RPC ${method}: invalid envelope`);
    if (data.error) {
      const code = Number.isSafeInteger(data.error.code) ? data.error.code : 'unknown';
      const err = new RpcError(`RPC ${method} failed (${code})`, code);
      err.isRevert = data.error.code === 3 || /execution reverted|vm execution error|\brevert\b/i.test(String(data.error.message || ''));
      throw err;
    }
    if (!Object.hasOwn(data, 'result')) throw new RpcError(`RPC ${method}: missing result`);
    return data.result;
  };
}
export function evmAddress(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid EVM address');
  return address;
}
export function base58Bytes(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value) || value.length > 90) throw new Error('Invalid base58 value');
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  let size = 0;
  while (n) { n >>= 8n; size++; }
  return size + (value.match(/^1*/) || [''])[0].length;
}
export function solanaAddress(value) {
  if (base58Bytes(value) !== 32) throw new Error('Invalid Solana address');
  return value;
}
export function chainName(value = 'solana') {
  if (!['solana', 'base'].includes(value)) throw new Error('Chain must be solana or base');
  return value;
}
export function raw(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Unsafe on-chain integer');
  } else if (typeof value !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) throw new Error('Invalid on-chain integer');
  return BigInt(value);
}
export const pct = (part, total) => total > 0n ? Math.min(100, Number(part * 10000n / total) / 100) : null;
export function risk(flags) {
  const safetyScore = Math.max(0, 100 - flags.reduce((n, f) => n + f.penalty, 0));
  return { safetyScore, riskLevel: safetyScore <= 25 ? 'CRITICAL' : safetyScore <= 50 ? 'HIGH' : safetyScore <= 80 ? 'MEDIUM' : 'LOW', flags, disclaimer: 'Heuristic risk indicators, not an audit or a guarantee of sellability.' };
}
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index], index); }
  }));
  return results;
}
export const flag = (code, penalty, detail) => ({ code, penalty, detail });
