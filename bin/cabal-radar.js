#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startMcpServer } from '../src/mcp-server.js';
import { callTool, getUpgradeInfo, environmentOptions } from '../src/service.js';
import { checkProStatus } from '../src/license.js';
import { inferChain, chainName } from '../src/rpc.js';
const help = `cabal-radar 1.0.0 — Solana & Base risk intelligence
Usage:
  cabal-radar mcp (or --mcp)
  cabal-radar scan <address> [--chain solana|base] [--pro] [--json]
  cabal-radar upgrade
  cabal-radar activate --tx <hash_or_signature> --chain base|solana
  cabal-radar status
Options: --help, --version
RPC overrides: SOLANA_RPC_URL, BASE_RPC_URL
License override: CABAL_RADAR_LICENSE_PATH`;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { mcp: { type: 'boolean' }, chain: { type: 'string' }, tx: { type: 'string' }, pro: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' } } });
  if (values.help) console.log(help);
  else if (values.version) console.log('1.0.0');
  else {
    const [command = 'mcp', address, ...extra] = positionals;
    if (extra.length || (command !== 'scan' && address)) throw new Error('Unexpected positional argument');
    const allowed = { mcp: ['mcp'], scan: ['chain','pro','json'], upgrade: ['json'], activate: ['tx','chain','json'], status: ['json'] };
    if (!allowed[command]) throw new Error('Unknown command; use --help');
    for (const key of Object.keys(values)) if (!allowed[command].includes(key)) throw new Error(`--${key} is not valid for ${command}`);
    const chain = (command === 'scan' ? inferChain(address, values.chain) : chainName(values.chain)), options = environmentOptions(chain);
    let result;
    if (command === 'mcp') await startMcpServer();
    else if (command === 'upgrade') result = getUpgradeInfo(options);
    else if (command === 'status') result = await checkProStatus(options);
    else if (command === 'activate') {
      if (!values.tx || !values.chain) throw new Error('Activation requires --tx and --chain');
      result = await callTool('activate_pro_license', { chain, txHash: values.tx }, options);
    } else {
      if (!address) throw new Error('Scan requires a token address');
      result = await callTool(values.pro ? 'detect_block0_bundler' : 'scan_token_safety', { address, chain }, options);
      if (values.pro && !result.error) result = { basic: result.basic, deep: result };
    }
    if (result) {
      if (values.json || !['scan','status'].includes(command)) console.log(JSON.stringify(result, null, 2));
      else if (command === 'status') console.log(`${result.tier} • ${result.challenge}`);
      else if (result.error) console.log(JSON.stringify(result, null, 2));
      else { const basic = result.basic || result; console.log(`${basic.chain} ${basic.address}\nSafety score: ${basic.safetyScore}/100 (${basic.riskLevel})\n${basic.flags.map(f => `• ${f.detail}`).join('\n')}\n${basic.disclaimer}\n${result.deep ? JSON.stringify(result.deep, null, 2) : basic.proPreview}`); }
      if (result.error) process.exitCode = 1;
    }
  }
} catch (e) { console.error(`Error: ${e.code?.startsWith?.('E') ? 'Local file or stream operation failed' : e.message}`); process.exitCode = 1; }
