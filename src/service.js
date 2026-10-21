import { paymentInfo } from './constants.js';
import { getMachineChallenge, checkProStatus, saveLicense } from './license.js';
import { inferChain, chainName, mapLimit } from './rpc.js';
import { scanSolanaTokenBasic, detectSolanaBlock0Bundler, traceSolanaFundingClusters } from './solana-scanner.js';
import { scanBaseTokenBasic, detectBaseEarlyBundlerAndHoneypot, traceBaseFundingClusters } from './base-scanner.js';
const chain = {
  type: 'string', enum: ['solana', 'base'], default: 'solana',
  description: 'Mainnet to query: solana or base; optional, defaults to solana. Addresses in the corresponding token entry or request must match this chain.'
};
const inferredChain = { type: 'string', enum: ['solana', 'base'], description: 'Optional mainnet; inferred as base for a 0x-prefixed 40-hex token address, otherwise solana. Explicit values must match the address.' };
const token = {
  type: 'object',
  description: 'One token to audit: required address and optional chain (auto-detected from address); no other fields are accepted.',
  properties: {
    address: { type: 'string', description: 'Required token address, with no default: a Solana Base58 SPL mint decoding to 32 bytes, or a Base ERC-20 contract address with 0x followed by 40 hex digits, according to chain; at most 512 characters.' },
    chain: inferredChain
  },
  required: ['address'], additionalProperties: false
};
export const TOOLS = [
  {
    name: 'scan_token_safety',
    description: 'Scan one mainnet token through read-only RPC calls and return JSON with chain, address, safetyScore, riskLevel, flags, chain-specific metadata and limitations. Supply a Solana Base58 mint or Base 0x-prefixed 40-hex contract address; chain is inferred from address when omitted. Use this free initial screen before detect_block0_bundler for early-acquisition evidence, trace_funding_clusters for wallet relationships, or batch_audit_watchlist for multiple tokens; scores are heuristics, not proof of safety.',
    annotations: { title: 'Scan Token Safety', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: token
  },
  {
    name: 'get_pro_upgrade_info',
    description: 'Read local machine identity and configured payment options to return JSON containing tier, machine_id, challenge, payments, instructions and trustModel, without network calls or local writes. Accepts no parameters and requires no wallet connection. Use when a Pro analysis tool returns PRO_REQUIRED or before paying; after a qualifying confirmed payment, use activate_pro_license to save the license.',
    annotations: { title: 'Get Pro Upgrade Info', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'activate_pro_license',
    description: 'Verify an existing mainnet payment through RPC, save or replace the machine-bound local Pro license, and return JSON with active, tier, machine_id, challenge and, when active, chain and txHash. Requires both txHash (Solana Base58 signature or Base 0x-prefixed 64-hex hash) and chain (solana or base), despite the chain schema default. Use after get_pro_upgrade_info and a qualifying confirmed payment to unlock detect_block0_bundler, trace_funding_clusters and batch_audit_watchlist; this tool sends no payment and needs no private key or wallet signature.',
    annotations: { title: 'Activate Pro License', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        txHash: { type: 'string', description: 'Required confirmed qualifying payment receipt, with no default: a Solana Base58 transaction signature decoding to 64 bytes, or a Base hash with 0x followed by 64 hex digits, matching chain; at most 512 characters. Obtain payment requirements from get_pro_upgrade_info first.' },
        chain: { ...chain, description: 'Required payment mainnet: solana or base, matching txHash. The schema declares solana as default, but validation still requires an explicit value; it is not filled in automatically.' }
      },
      required: ['txHash', 'chain'], additionalProperties: false
    }
  },
  {
    name: 'detect_block0_bundler',
    description: 'Analyze one mainnet token via read-only RPC and return JSON with basic scan, bundlerVerdict, coordinatedWallets, coverage and limitations, plus Solana clusters or Base transferSimulation and honeypotVerdict; bounded history does not prove launch coverage or sellability. Requires a Solana Base58 mint or Base 0x-prefixed 40-hex contract address; chain is inferred from address when omitted, Base fromBlock defaults to max(0, latest minus 2000) and must be within 10000 blocks of latest, and optional Base transfer simulation requires non-empty simulationFrom, simulationTo and simulationAmount together. On Base, transferSimulation.status is NOT_RUN when all three are omitted, or when simulationFrom and simulationTo are omitted or empty strings and simulationAmount is omitted; partial non-empty combinations fail validation. Base-only parameters still undergo inputSchema type/pattern validation before chain dispatch and are unused on Solana after passing schema validation. Use after scan_token_safety for deeper acquisition evidence, trace_funding_clusters for wallet funding links, or batch_audit_watchlist for multiple tokens with default analysis settings. Requires local Pro; otherwise returns PRO_REQUIRED with upgrade information from get_pro_upgrade_info for use before activate_pro_license.',
    annotations: { title: 'Detect Block-0 Bundler', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      ...token,
      description: 'One token to analyze: required address, optional chain (auto-detected from address), optional Base fromBlock, and optional Base transfer-simulation parameters simulationFrom, simulationTo and simulationAmount. On Base, supply all three non-empty together to run simulation; partial non-empty combinations fail validation. If all three are omitted, or simulationFrom and simulationTo are omitted or empty strings without simulationAmount, transferSimulation.status is NOT_RUN. Base-only parameters still undergo inputSchema type/pattern validation before chain dispatch and are unused on Solana after passing schema validation; no other fields are accepted.',
      properties: {
        ...token.properties,
        fromBlock: { type: 'integer', minimum: 0, description: 'Optional Base-only inclusive start block: nonnegative safe integer, no later than latest and at most 10000 blocks behind it. Defaults to max(0, latest minus 2000). Still undergoes inputSchema integer/minimum validation before chain dispatch; unused on Solana after passing schema validation. Narrow the range if the query exceeds 20000 transfers.' },
        simulationFrom: { type: 'string', description: 'Optional Base-only funded token holder address: 0x followed by 40 hex digits, at most 512 characters. No default; on Base, supply non-empty simulationFrom, simulationTo and simulationAmount together to simulate transfer via read-only eth_call; partial non-empty combinations fail validation. If both addresses are omitted or empty strings and simulationAmount is omitted, transferSimulation.status is NOT_RUN. Still undergoes inputSchema string-type validation before chain dispatch; unused on Solana after passing schema validation.' },
        simulationTo: { type: 'string', description: 'Optional Base-only transfer recipient address: 0x followed by 40 hex digits, at most 512 characters. No default; on Base, supply non-empty simulationFrom, simulationTo and simulationAmount together to run simulation; partial non-empty combinations fail validation. If both addresses are omitted or empty strings and simulationAmount is omitted, transferSimulation.status is NOT_RUN. Still undergoes inputSchema string-type validation before chain dispatch; unused on Solana after passing schema validation.' },
        simulationAmount: { type: 'string', pattern: '^[0-9]+$', description: 'Optional Base-only amount in raw token units as a decimal digit string (no sign, decimal point or exponent), at most 512 characters; must be greater than 0 and less than 2^256 for simulation. No default; on Base, supply non-empty simulationFrom, simulationTo and simulationAmount together to run simulation; partial non-empty combinations fail validation. Omit this amount with both addresses omitted or empty strings for transferSimulation.status NOT_RUN; an empty amount string fails schema pattern validation. Still undergoes inputSchema type/pattern validation before chain dispatch; unused on Solana after passing schema validation.' }
      }
    }
  },
  {
    name: 'trace_funding_clusters',
    description: 'Trace shared funding for 1–20 wallet-owner addresses via read-only RPC and return Solana JSON with clusters, motherWallets, sybilClusterPct, denominator, coverage and limitations; Base returns status UNSUPPORTED, empty clusters and null sybilClusterPct because an indexer is required. Supply Solana Base58 wallets or Base 0x-prefixed 40-hex wallets matching chain, which defaults to solana; Solana deduplicates wallets and the percentage measures provided unique wallets, not token supply. Use for wallet relationships, scan_token_safety for token screening, detect_block0_bundler for early acquisitions, or batch_audit_watchlist for multiple token audits. Requires local Pro; otherwise returns PRO_REQUIRED with get_pro_upgrade_info details for subsequent activate_pro_license use.',
    annotations: { title: 'Trace Funding Clusters', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        chain,
        holderAddresses: {
          type: 'array', minItems: 1, maxItems: 20,
          description: 'Required list of 1–20 wallet-owner addresses on the selected chain, with no default; provide owners, not Solana token accounts. Solana duplicates are collapsed before calculating wallet percentages; Base currently returns UNSUPPORTED.',
          items: { type: 'string', description: 'Wallet owner on chain: Solana Base58 public key decoding to 32 bytes or Base address with 0x followed by 40 hex digits; at most 512 characters, with no default.' }
        }
      },
      required: ['holderAddresses'], additionalProperties: false
    }
  },
  {
    name: 'batch_audit_watchlist',
    description: 'Audit 1–20 mainnet tokens through read-only RPC with concurrency 3 and return JSON containing results (each with address, chain, basic and deep, or error) and generatedAt; format markdown adds a markdown field while retaining JSON. Each entry requires a Solana Base58 mint or Base 0x-prefixed 40-hex contract address, with per-entry chain inferred from address when omitted; format defaults to json and deep scans use default settings without transfer simulation. Use for multiple tokens, scan_token_safety for one free screen, detect_block0_bundler for one configurable deep scan, or trace_funding_clusters for wallet relationships. Requires local Pro; otherwise returns PRO_REQUIRED with get_pro_upgrade_info details for subsequent activate_pro_license use.',
    annotations: { title: 'Batch Audit Watchlist', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        tokens: { type: 'array', items: token, minItems: 1, maxItems: 20, description: 'Required list of 1–20 token objects, with no default; each supplies address and optional chain (auto-detected from address when omitted). Mixed chains are allowed; audits use default deep-scan settings and individual failures appear in results.' },
        format: { type: 'string', enum: ['json', 'markdown'], default: 'json', description: 'Optional output format: json (default) or markdown. Both return JSON results and generatedAt; markdown additionally includes a Markdown summary table in the markdown field.' }
      },
      required: ['tokens'], additionalProperties: false
    }
  }
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
  const chain = (['scan_token_safety', 'detect_block0_bundler'].includes(name) ? inferChain(args.address, args.chain) : chainName(args.chain)), opts = { ...environmentOptions(chain), ...options };
  if (name === 'get_pro_upgrade_info') return getUpgradeInfo(opts);
  if (name === 'activate_pro_license') { await saveLicense({ chain, txHash: args.txHash }, opts); return checkProStatus(opts); }
  if (name === 'scan_token_safety') return basicScan(args.address, chain, opts);
  if (!(await checkProStatus(opts)).active) return { error: 'PRO_REQUIRED', ...getUpgradeInfo(opts) };
  if (name === 'detect_block0_bundler') return deepScan(args.address, chain, { ...opts, ...args });
  if (name === 'trace_funding_clusters') return chain === 'base' ? traceBaseFundingClusters(args.holderAddresses, opts) : traceSolanaFundingClusters(args.holderAddresses, opts);
  const results = await mapLimit(args.tokens, 3, async t => {
    const c = inferChain(t.address, t.chain), o = { ...environmentOptions(c), ...options };
    try { const basic = await basicScan(t.address, c, o); return { address: t.address, chain: c, basic, deep: await deepScan(t.address, c, { ...o, basic }) }; }
    catch (error) { return { address: t.address, chain: c, error: error.message }; }
  });
  const result = { results, generatedAt: new Date().toISOString() };
  if (args.format === 'markdown') result.markdown = '# Cabal Radar watchlist\n\n| Chain | Address | Score | Risk |\n|---|---|---:|---|\n' + results.map(r => `| ${r.chain} | ${r.address.replace(/[|\r\n]/g,'')} | ${r.basic?.safetyScore ?? '—'} | ${r.basic?.riskLevel ?? 'ERROR'} |`).join('\n') + '\n\nHeuristic analysis; consult JSON for coverage and errors.\n';
  return result;
}
