import { paymentInfo } from './constants.js';
import { getMachineChallenge, checkProStatus, saveLicense } from './license.js';
import { chainName, mapLimit } from './rpc.js';
import { scanSolanaTokenBasic, detectSolanaBlock0Bundler, traceSolanaFundingClusters } from './solana-scanner.js';
import { scanBaseTokenBasic, detectBaseEarlyBundlerAndHoneypot, traceBaseFundingClusters } from './base-scanner.js';
const str = { type: 'string' }, chain = { type: 'string', enum: ['solana', 'base'], default: 'solana' };
const token = { type: 'object', properties: { address: str, chain }, required: ['address'], additionalProperties: false };
export const TOOLS = [
  { name: 'scan_token_safety', description: 'Free Solana or Base token risk heuristics with evidence and limitations.', inputSchema: token },
  { name: 'get_pro_upgrade_info', description: 'Payment options and local activation instructions. No wallet connection.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'activate_pro_license', description: 'Verify a mainnet payment receipt and save a machine-bound local Pro license.', inputSchema: { type: 'object', properties: { txHash: str, chain }, required: ['txHash', 'chain'], additionalProperties: false } },
  { name: 'detect_block0_bundler', description: 'Pro: bounded early-acquisition analysis. Launch coverage is explicitly reported.', inputSchema: { ...token, properties: { ...token.properties, fromBlock: { type: 'integer', minimum: 0 }, simulationFrom: str, simulationTo: str, simulationAmount: { type: 'string', pattern: '^[0-9]+$' } } } },
  { name: 'trace_funding_clusters', description: 'Pro: Solana shared-funder heuristics for wallet owners. Base reports unsupported without an indexer.', inputSchema: { type: 'object', properties: { chain, holderAddresses: { type: 'array', items: str, minItems: 1, maxItems: 20 } }, required: ['holderAddresses'], additionalProperties: false } },
  { name: 'batch_audit_watchlist', description: 'Pro: audit up to 20 tokens with bounded concurrency; return JSON and optional Markdown.', inputSchema: { type: 'object', properties: { tokens: { type: 'array', items: token, minItems: 1, maxItems: 20 }, format: { type: 'string', enum: ['json', 'markdown'], default: 'json' } }, required: ['tokens'], additionalProperties: false } }
];
export function validate(value, schema, path = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) throw new Error(`${path}.${k} is required`);
    for (const k of Object.keys(value)) { if (!Object.hasOwn(schema.properties, k)) throw new Error(`Unknown ${path}.${k}`); validate(value[k], schema.properties[k], `${path}.${k}`); }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) throw new Error(`${path} has invalid array length`);
    value.forEach((v,i) => validate(v,schema.items,`${path}[${i}]`));
  } else if (schema.type === 'integer') { if (!Number.isSafeInteger(value) || value < schema.minimum) throw new Error(`${path} must be a nonnegative safe integer`); }
  else if (typeof value !== schema.type || value.length > 512 || (schema.pattern && !new RegExp(schema.pattern).test(value))) throw new Error(`Invalid ${path}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${path}`);
}
export function getUpgradeInfo(options = {}) {
  return { tier: 'Pro', ...getMachineChallenge(options.customSalt), payments: paymentInfo(), instructions: ['Send ONE qualifying payment on the specified mainnet. Keep enough native currency for network fees.', 'Wait for confirmation, then run: cabal-radar activate --tx <hash_or_signature> --chain <base|solana>', 'Run cabal-radar status. Pro is local; no private keys, signatures or wallet connection are required.'], trustModel: 'Receipt-based activation. The challenge labels the local machine; it is not an on-chain ownership proof. Public receipts are replayable across machines. Deterministic local HMAC detects accidental edits, not a malicious local user. No central activation server or telemetry.' };
}
export const basicScan = (address, chain, options) => chain === 'base' ? scanBaseTokenBasic(address, options) : scanSolanaTokenBasic(address, options);
export const deepScan = (address, chain, options) => chain === 'base' ? detectBaseEarlyBundlerAndHoneypot(address, options) : detectSolanaBlock0Bundler(address, options);
export function environmentOptions(chain) {
  return { ...(process.env.CABAL_RADAR_LICENSE_PATH ? { licensePath: process.env.CABAL_RADAR_LICENSE_PATH } : {}), ...(process.env[chain === 'base' ? 'BASE_RPC_URL' : 'SOLANA_RPC_URL'] ? { rpcUrl: process.env[chain === 'base' ? 'BASE_RPC_URL' : 'SOLANA_RPC_URL'] } : {}) };
}
export async function callTool(name, args = {}, options = {}) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error('Unknown tool'); validate(args, tool.inputSchema);
  const chain = chainName(args.chain), opts = { ...environmentOptions(chain), ...options };
  if (name === 'get_pro_upgrade_info') return getUpgradeInfo(opts);
  if (name === 'activate_pro_license') { await saveLicense({ chain, txHash: args.txHash }, opts); return checkProStatus(opts); }
  if (name === 'scan_token_safety') return basicScan(args.address, chain, opts);
  if (!(await checkProStatus(opts)).active) return { error: 'PRO_REQUIRED', ...getUpgradeInfo(opts) };
  if (name === 'detect_block0_bundler') return deepScan(args.address, chain, { ...opts, ...args });
  if (name === 'trace_funding_clusters') return chain === 'base' ? traceBaseFundingClusters(args.holderAddresses, opts) : traceSolanaFundingClusters(args.holderAddresses, opts);
  const results = await mapLimit(args.tokens, 3, async t => {
    const c = chainName(t.chain), o = { ...environmentOptions(c), ...options };
    try { const basic = await basicScan(t.address, c, o); return { address: t.address, chain: c, basic, deep: await deepScan(t.address, c, { ...o, basic }) }; }
    catch (error) { return { address: t.address, chain: c, error: error.message }; }
  });
  const result = { results, generatedAt: new Date().toISOString() };
  if (args.format === 'markdown') result.markdown = '# Cabal Radar watchlist\n\n| Chain | Address | Score | Risk |\n|---|---|---:|---|\n' + results.map(r => `| ${r.chain} | ${r.address.replace(/[|\r\n]/g,'')} | ${r.basic?.safetyScore ?? '—'} | ${r.basic?.riskLevel ?? 'ERROR'} |`).join('\n') + '\n\nHeuristic analysis; consult JSON for coverage and errors.\n';
  return result;
}
