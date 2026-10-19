import { TRANSFER_TOPIC, BASE_CHAIN_ID } from './constants.js';
import { rpcClient, evmAddress, raw, pct, risk, flag } from './rpc.js';
import { selector } from './keccak.js';
const ZERO = `0x${'0'.repeat(40)}`;
const word = n => BigInt(n).toString(16).padStart(64, '0');
const addrWord = a => a.slice(2).toLowerCase().padStart(64, '0');
export function inspectBytecode(code) {
  if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(code)) throw new Error('Invalid contract bytecode');
  // Scan all bytes: untrusted metadata can contain executable jump targets.
  const hex = code.slice(2).toLowerCase();
  const ops = new Set(), pushes = new Set();
  for (let i = 0; i < hex.length;) {
    const op = parseInt(hex.slice(i, i+2), 16); i += 2; ops.add(op);
    if (op >= 0x60 && op <= 0x7f) { const size = op - 0x5f; if (size === 4) pushes.add(hex.slice(i, i+8)); i += size * 2; }
  }
  const flags = [];
  if (ops.has(0xff)) flags.push(flag('SELFDESTRUCT', 15, 'SELFDESTRUCT opcode found; effects depend on EVM fork semantics and reachability'));
  if (ops.has(0xf4)) flags.push(flag('DELEGATECALL', 25, 'Delegatecall or proxy; implementation and upgrade permissions require separate review'));
  const signatures = [
    ['blacklist(address)', 'BLACKLIST', 25], ['isBlacklisted(address)', 'BLACKLIST', 25], ['setBlacklist(address,bool)', 'BLACKLIST', 25],
    ['setTax(uint256)', 'MUTABLE_TAX', 20], ['setFee(uint256)', 'MUTABLE_TAX', 20], ['setTaxes(uint256,uint256)', 'MUTABLE_TAX', 20],
    ['pause()', 'PAUSABLE', 15], ['unpause()', 'PAUSABLE', 15], ['mint(address,uint256)', 'MINT', 25]
  ];
  for (const [signature, code, penalty] of signatures) if (pushes.has(selector(signature)) && !flags.some(f => f.code === code)) flags.push(flag(code, penalty, `PUSH4 selector for ${signature}; reachability and permissions unverified`));
  return { flags, selectors: [...pushes], permitPresent: pushes.has(selector('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)')), approvalPresent: pushes.has(selector('approve(address,uint256)')) };
}
function decodeSymbol(hex) {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    const bytes = hex.slice(2); let data = bytes;
    if (bytes.length >= 128) {
      const offset = Number(raw(`0x${bytes.slice(0,64)}`)) * 2;
      if (!Number.isSafeInteger(offset) || offset + 64 > bytes.length) return null;
      const length = Number(raw(`0x${bytes.slice(offset,offset+64)}`));
      if (length > 128 || offset + 64 + length * 2 > bytes.length) return null;
      data = bytes.slice(offset+64,offset+64+length*2);
    } else if (bytes.length !== 64) return null;
    return new TextDecoder().decode(Uint8Array.from(data.match(/../g) || [], b => parseInt(b,16))).replace(/\0+$/, '').replace(/[\x00-\x1f\x7f]/g, '').slice(0,128);
  } catch { return null; }
}
export async function scanBaseTokenBasic(tokenAddress, options = {}) {
  evmAddress(tokenAddress); const rpc = rpcClient('base', options);
  if (await rpc('eth_chainId') !== BASE_CHAIN_ID) throw new Error('Expected Base mainnet chain ID');
  const code = await rpc('eth_getCode', [tokenAddress, 'latest']);
  if (!code || code === '0x') throw new Error('No contract at address');
  const analysis = inspectBytecode(code), flags = [...analysis.flags], unavailable = [];
  const call = async signature => {
    try { return await rpc('eth_call', [{ to: tokenAddress, data: `0x${selector(signature)}` }, 'latest']); }
    catch (e) { if (!e.isRevert) throw e; unavailable.push(signature); return null; }
  };
  const [supplyHex, ownerHex, symbolHex, decimalsHex] = await Promise.all(['totalSupply()', 'owner()', 'symbol()', 'decimals()'].map(call));
  let supply = null, decimals = null;
  try { supply = raw(supplyHex).toString(); } catch { unavailable.push('totalSupply()'); }
  try { decimals = Number(raw(decimalsHex)); if (decimals > 255) decimals = null; } catch { /* nonstandard ERC20 */ }
  const owner = /^0x[0-9a-fA-F]{64}$/.test(ownerHex || '') ? `0x${ownerHex.slice(-40)}` : null;
  if (owner && owner.toLowerCase() !== ZERO) flags.push(flag('OWNER_PRESENT', 10, 'Nonzero owner; powers need implementation review'));
  if (supply === null || decimals === null) flags.push(flag('INCOMPLETE_METADATA', 30, 'Required ERC20 metadata unavailable'));
  if (supply === '0') flags.push(flag('ZERO_SUPPLY', 40, 'Zero supply'));
  if (!owner) flags.push(flag('OWNER_UNKNOWN', 10, 'owner() unavailable; ownership renunciation cannot be inferred'));
  return { chain: 'base', address: tokenAddress, supply, owner, symbol: decodeSymbol(symbolHex), decimals, ...risk(flags), bytecode: analysis, unavailable: [...new Set(unavailable)], proPreview: 'Pro inspects earliest observed Transfer concentration and transfer restrictions. Static checks cannot establish sellability.', limitations: ['Selectors and opcodes are heuristic; proxy implementation is not resolved.', 'No detected flag does not imply absence of hidden controls.'] };
}
export async function detectBaseEarlyBundlerAndHoneypot(tokenAddress, options = {}) {
  const basic = options.basic ?? await scanBaseTokenBasic(tokenAddress, options), rpc = rpcClient('base', options);
  const latest = raw(await rpc('eth_blockNumber'));
  const from = options.fromBlock !== undefined ? raw(options.fromBlock) : latest > 2000n ? latest - 2000n : 0n;
  if (from > latest || latest - from > 10000n) throw new Error('Transfer history range must be within 10000 blocks');
  const logs = [];
  for (let start = from; start <= latest; start += 500n) {
    const end = start + 499n > latest ? latest : start + 499n;
    const rows = await rpc('eth_getLogs', [{ address: tokenAddress, topics: [TRANSFER_TOPIC], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }]);
    if (!Array.isArray(rows)) throw new Error('Invalid Transfer logs');
    logs.push(...rows.filter(l => !l.removed && l.address?.toLowerCase() === tokenAddress.toLowerCase() && l.topics?.length === 3 && l.topics.every(t => /^0x[0-9a-fA-F]{64}$/.test(t)) && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC && /^0x[0-9a-fA-F]{64}$/.test(l.data)));
    if (logs.length > 20000) throw new Error('Too many transfers; narrow fromBlock');
  }
  const unique = [...new Map(logs.map(l => [`${l.transactionHash}:${l.logIndex}`, l])).values()].sort((a,b) => Number(raw(a.blockNumber) - raw(b.blockNumber)));
  const first = unique.length ? raw(unique[0].blockNumber) : null;
  const nonMintTransfers = unique.filter(l => raw(l.data) > 0n && !/^0x0{64}$/i.test(l.topics[1]) && !/^0x0{64}$/i.test(l.topics[2]));
  const firstTransferBlock = nonMintTransfers.length ? raw(nonMintTransfers[0].blockNumber) : null;
  const early = nonMintTransfers.filter(l => raw(l.blockNumber) <= firstTransferBlock + 1n);
  const recipients = new Map();
  for (const l of early) { const a = `0x${l.topics[2].slice(-40)}`.toLowerCase(); recipients.set(a, (recipients.get(a) || 0n) + raw(l.data)); }
  const amounts = [...recipients.values()], total = amounts.reduce((n,a) => n+a, 0n), max = amounts.reduce((n,a) => a > n ? a : n, 0n);
  let transferSimulation = { status: 'NOT_RUN', reason: 'Provide simulationFrom (funded holder), simulationTo and simulationAmount for eth_call.' };
  if (options.simulationFrom || options.simulationTo || options.simulationAmount !== undefined) {
    evmAddress(options.simulationFrom); evmAddress(options.simulationTo); const amount = raw(options.simulationAmount);
    if (amount === 0n || amount >= 1n << 256n) throw new Error('Simulation amount must be a positive uint256');
    try {
      const result = await rpc('eth_call', [{ from: options.simulationFrom, to: tokenAddress, data: `0xa9059cbb${addrWord(options.simulationTo)}${word(amount)}` }, 'latest']);
      transferSimulation = { status: result === '0x' || result === `0x${word(1)}` ? 'CALL_SUCCEEDED' : result === `0x${word(0)}` ? 'RETURNED_FALSE' : 'NONSTANDARD_RETURN', result };
    } catch (e) { if (!e.isRevert) throw e; transferSimulation = { status: 'REVERTED', reason: 'May be insufficient balance, limits, pause or restriction; not proof of honeypot.' }; }
  }
  const controls = basic.flags.filter(f => ['BLACKLIST','MUTABLE_TAX','PAUSABLE','DELEGATECALL'].includes(f.code));
  return { basic, chain: 'base', address: tokenAddress, firstObservedBlock: first?.toString() ?? null, earlyWalletCount: recipients.size, coordinatedWallets: [...recipients.keys()], largestEarlyRecipientPct: pct(max, total), bundlerVerdict: recipients.size >= 3 ? 'EARLY_CONCENTRATION_OBSERVED' : 'INSUFFICIENT_EVIDENCE', honeypotVerdict: controls.length || ['REVERTED', 'RETURNED_FALSE', 'NONSTANDARD_RETURN'].includes(transferSimulation.status) ? 'REVIEW_REQUIRED' : 'UNKNOWN', transferTax: { buyPct: null, sellPct: null, status: 'UNKNOWN', reason: 'Generic eth_call returns no balance deltas. A funded route-specific buy/sell fork simulation is required to measure tax.' }, transferSimulation, lockIndicators: controls, approvalInspection: { approveSelectorPresent: basic.bytecode.approvalPresent, permitSelectorPresent: basic.bytecode.permitPresent, unlimitedApprovalRisk: basic.bytecode.approvalPresent || basic.bytecode.permitPresent ? 'Approval/permit capability found; do not sign unlimited allowances for untrusted spenders.' : 'UNKNOWN', note: 'Standard approve/permit selectors alone are not malicious. No signatures or approvals are requested.' }, coverage: { firstObservedBlock: first?.toString() ?? null, firstTransferBlock: firstTransferBlock?.toString() ?? null, fromBlock: from.toString(), toBlock: latest.toString(), transferCount: unique.length, launchVerified: false }, limitations: ['Earliest observed transfer is not necessarily token launch or a DEX buy.', 'Recipient percentages measure gross observed transfer volume, not supply or beneficial ownership.', 'A successful transfer call does not prove a DEX sell will succeed.'] };
}
export async function traceBaseFundingClusters(holderAddresses, options = {}) {
  if (!Array.isArray(holderAddresses) || !holderAddresses.length || holderAddresses.length > 20) throw new Error('Provide 1–20 wallet addresses');
  holderAddresses.forEach(evmAddress);
  return { chain: 'base', status: 'UNSUPPORTED', clusters: [], sybilClusterPct: null, reason: 'Standard Base JSON-RPC has no address transaction-history endpoint. Use Solana for funding clustering; Base funding attribution requires an indexer.' };
}
