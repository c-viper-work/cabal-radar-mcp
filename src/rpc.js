import { BASE_RPC_URL, SOLANA_RPC_URL } from './constants.js';
export class RpcError extends Error {
  constructor(message, code) { super(message); this.name = 'RpcError'; this.code = code; this.isRevert = code === 3 || /execution reverted|vm execution error|\brevert\b/i.test(message); }
}
export function rpcClient(chain, options = {}) {
  const isDefaultFetch = !options.rpc && (!options.fetch || options.fetch === globalThis.fetch);
  const noFailover = options.disableFailover || (typeof process !== 'undefined' && process.env?.CABAL_RADAR_NO_FAILOVER === '1');
  const primaryUrl = options.rpcUrl || (chain === 'base' ? BASE_RPC_URL : SOLANA_RPC_URL);
  const fallbackUrl = !options.rpcUrl && isDefaultFetch && !noFailover ? (chain === 'base' ? 'https://base-rpc.publicnode.com' : 'https://solana-rpc.publicnode.com') : null;
  let id = 0;
  const once = async (method, params = [], targetUrl = primaryUrl) => {
    options.signal?.throwIfAborted();
    if (options.rpc) return options.rpc(method, params);
    const requestId = ++id;
    let response;
    try {
      response = await (options.fetch || globalThis.fetch)(targetUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs || 15000), ...(options.signal ? [options.signal] : [])]), redirect: 'error'
      });
    } catch { throw new RpcError(`RPC ${method}: network failure or timeout`); }
    if (!response.ok) {
      const err = new RpcError(`RPC ${method}: HTTP ${response.status}`, response.status);
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = Math.min(10000, Math.round(retryAfter * 1000));
      throw err;
    }
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
  const retries = options.maxRetries ?? (isDefaultFetch ? 4 : 0);
  let activeUrl = primaryUrl, failedOver = false;
  return async (method, params = []) => {
    for (let attempt = 0; ; attempt++) {
      try { return await once(method, params, activeUrl); }
      catch (err) {
        options.signal?.throwIfAborted();
        const canFailover = fallbackUrl && !failedOver && activeUrl === primaryUrl && err?.name === 'RpcError' && (isRateLimit(err) || err.code === 403 || /HTTP 403|network failure/.test(err.message));
        if (canFailover) { failedOver = true; activeUrl = fallbackUrl; attempt--; continue; }
        if (attempt >= retries || !isRateLimit(err)) throw err;
        const delayMs = err.retryAfterMs ?? Math.round((options.baseDelayMs || 250) * (2 ** attempt) * (0.75 + Math.random() * 0.5));
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
          const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
          options.signal?.addEventListener('abort', abort, { once: true });
        });
      }
    }
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

export const isRateLimit = err => err?.name === 'RpcError' && ([429, 503, -32005, -32011, -32012].includes(err.code) || /HTTP (429|503)/.test(err.message));
export function inferChain(address, explicitChain) {
  if (explicitChain !== undefined) return chainName(explicitChain);
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) ? 'base' : 'solana';
}
export async function solanaTransaction(rpc, signature) {
  const params = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' };
  try { return await rpc('getTransaction', [signature, params]); }
  catch (err) {
    if (err?.name !== 'RpcError' || !(err.code === -32015 || /version|maxSupportedTransactionVersion/i.test(err.message))) throw err;
    return rpc('getTransaction', [signature, { ...params, maxSupportedTransactionVersion: 1 }]);
  }
}
export async function enrichmentJson(url, options = {}) {
  if (options.disableEnrichment || (typeof process !== 'undefined' && process.env?.CABAL_RADAR_NO_ENRICHMENT === '1')) throw new Error('Enrichment disabled');
  const response = await (options.enrichmentFetch || globalThis.fetch)(url, {
    signal: AbortSignal.any([AbortSignal.timeout(4000), ...(options.signal ? [options.signal] : [])]), redirect: 'error'
  });
  if (!response.ok) throw new Error('Enrichment unavailable');
  return response.json();
}
