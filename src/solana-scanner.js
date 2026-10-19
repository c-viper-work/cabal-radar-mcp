import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, JITO_TIP_ACCOUNTS, SOLANA_GENESIS } from './constants.js';
import { rpcClient, solanaAddress, raw, pct, risk, flag, mapLimit } from './rpc.js';
export async function scanSolanaTokenBasic(mintAddress, options = {}) {
  solanaAddress(mintAddress); const rpc = rpcClient('solana', options);
  if (await rpc('getGenesisHash') !== SOLANA_GENESIS) throw new Error('Expected Solana mainnet genesis');
  let holderDataUnavailable = false;
  const [account, largest] = await Promise.all([
    rpc('getAccountInfo', [mintAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    rpc('getTokenLargestAccounts', [mintAddress, { commitment: 'confirmed' }]).catch(err => {
      if (err?.name === 'RpcError' && (/HTTP (429|403)/.test(err.message) || [-32000, -32005, -32012, 429].includes(err.code))) {
        holderDataUnavailable = true;
        return;
      }
      throw err;
    })
  ]);
  const value = account?.value, info = value?.data?.parsed?.info;
  if (!info || value.data.parsed.type !== 'mint' || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(value.owner)) throw new Error('Address is not a parsed SPL token mint');
  const supply = raw(info.supply), flags = [];
  if (!Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 255) throw new Error('Invalid mint decimals');
  if (info.mintAuthority) flags.push(flag('MINT_AUTHORITY', 25, 'Mint authority can increase supply'));
  if (info.freezeAuthority) flags.push(flag('FREEZE_AUTHORITY', 25, 'Freeze authority can lock token accounts'));
  const dangerousExtensions = [];
  for (const e of info.extensions || []) {
    const name = e.extension;
    if ((name === 'permanentDelegate' && (!e.state || e.state.delegate != null)) || (name === 'transferHook' && (e.state?.programId || e.state?.authority))) { dangerousExtensions.push(e); flags.push(flag(name, 25, 'Extended transfer or delegate control')); }
    if (name === 'nonTransferable') { dangerousExtensions.push(e); flags.push(flag('NON_TRANSFERABLE', 35, 'Token-2022 nonTransferable extension prevents standard transfers')); }
    if (['pausableConfig', 'pausable'].includes(name) && (e.state?.paused === true || e.state?.authority != null)) { dangerousExtensions.push(e); flags.push(flag('PAUSABLE', e.state?.paused === true ? 35 : 20, e.state?.paused === true ? 'Token transfers are paused' : 'Pause authority can stop token transfers')); }
    if (name === 'transferFeeConfig') {
      const bps = Math.max(Number(e.state?.newerTransferFee?.transferFeeBasisPoints || 0), Number(e.state?.olderTransferFee?.transferFeeBasisPoints || 0));
      if (bps < 1000 && e.state?.transferFeeConfigAuthority != null) { dangerousExtensions.push(e); flags.push(flag('MUTABLE_TRANSFER_FEE', 15, 'Transfer fee authority can raise fees up to the configured cap')); }
      if (bps >= 1000) { dangerousExtensions.push(e); flags.push(flag('HIGH_TRANSFER_FEE', 25, `Configured fee up to ${bps / 100}% before maximum-fee cap`)); }
    }
    if (name === 'defaultAccountState' && [e.state?.accountState, e.state?.state].some(state => String(state).toLowerCase() === 'frozen')) { dangerousExtensions.push(e); flags.push(flag('DEFAULT_FROZEN', 30, 'New token accounts start frozen')); }
  }
  let holders = [], top10HolderPct = null, largestHolderPct = null;
  if (holderDataUnavailable) {
    flags.push(flag('HOLDER_DATA_UNAVAILABLE', 15, 'Largest-account query rate-limited or restricted by RPC; holder concentration not evaluated'));
  } else {
    if (!Array.isArray(largest?.value)) throw new Error('Missing largest token accounts');
    holders = largest.value.map(h => ({ address: h.address, amount: raw(h.amount).toString() })).sort((a, b) => raw(a.amount) > raw(b.amount) ? -1 : 1);
    top10HolderPct = pct(holders.slice(0, 10).reduce((n, h) => n + raw(h.amount), 0n), supply);
    largestHolderPct = pct(holders.length ? raw(holders[0].amount) : 0n, supply);
    if (holders.slice(0, 10).reduce((n, h) => n + raw(h.amount), 0n) * 100n > supply * 50n) flags.push(flag('TOP10_CONCENTRATION', 20, 'Top ten token accounts hold over half the supply; pools and vaults are not excluded'));
    if ((holders.length ? raw(holders[0].amount) : 0n) * 100n > supply * 20n) flags.push(flag('LARGE_ACCOUNT', 15, 'Largest token account exceeds 20% of supply'));
  }
  if (supply === 0n) flags.push(flag('ZERO_SUPPLY', 40, 'No circulating token supply to assess'));
  return { chain: 'solana', address: mintAddress, supply: supply.toString(), decimals: info.decimals, mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null, isToken2022: value.owner === TOKEN_2022_PROGRAM_ID, dangerousExtensions, top10HolderPct, largestHolderPct, holders, ...risk(flags), proPreview: 'Account concentration can hide shared funding. Pro samples early acquisitions, Jito tips and common funding origins.', limitations: ['Holder percentages are token-account concentration, not beneficial ownership.', 'Liquidity locks, pool ownership and sellability are not verified.'] };
}
export async function solanaHistory(address, options = {}, transactionCache = new Map()) {
  const rpc = rpcClient('solana', options), signatures = []; let before, exhausted = false;
  const pages = Math.min(10, Math.max(1, options.maxPages || 3));
  for (let page = 0; page < pages; page++) {
    const rows = await rpc('getSignaturesForAddress', [address, { limit: 100, ...(before ? { before } : {}), commitment: 'confirmed' }]);
    if (!Array.isArray(rows)) throw new Error('Invalid signature history');
    signatures.push(...rows); if (rows.length < 100) { exhausted = true; break; }
    if (before === rows.at(-1).signature) break;
    before = rows.at(-1).signature;
  }
  const selected = [...new Map(signatures.map((s, index) => [s.signature, { ...s, index }])).values()].filter(s => s.err === null).sort((a, b) => a.slot - b.slot || b.index - a.index).slice(0, Math.min(100, options.maxTransactions || 40));
  let missing = 0;
  const transactions = await mapLimit(selected, 4, async s => {
    if (!transactionCache.has(s.signature)) transactionCache.set(s.signature, rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]));
    const tx = await transactionCache.get(s.signature);
    if (!tx) missing++; return tx;
  });
  return { transactions: transactions.filter(t => t?.meta?.err === null), coverage: { historyExhausted: exhausted, signaturesExamined: signatures.length, transactionsExamined: selected.length, missingTransactions: missing, launchVerified: false, note: exhausted ? 'Oldest RPC-available history; archival completeness and launch are not proven.' : 'Bounded recent history; results must not be interpreted as actual launch Block-0.' } };
}
const instructions = tx => (tx.transaction?.message?.instructions || []).flatMap((instruction, idx) => [instruction, ...(tx.meta?.innerInstructions || []).filter(inner => inner.index === idx).flatMap(inner => inner.instructions || [])]);
export async function detectSolanaBlock0Bundler(mintAddress, options = {}) {
  solanaAddress(mintAddress);
  const basic = options.basic ?? await scanSolanaTokenBasic(mintAddress, options);
  const transactionCache = new Map();
  const history = await solanaHistory(mintAddress, options, transactionCache);
  const holderHistories = await mapLimit(basic.holders.slice(0, 5), 4, h => solanaHistory(h.address, { ...options, maxPages: 1, maxTransactions: 10 }, transactionCache));
  history.transactions = [...new Set([history, ...holderHistories].flatMap(h => h.transactions))];
  history.coverage = { ...history.coverage, holderAccountsSampled: holderHistories.length,
    historyExhausted: [history, ...holderHistories].every(h => h.coverage.historyExhausted),
    signaturesExamined: [history, ...holderHistories].reduce((n, h) => n + h.coverage.signaturesExamined, 0),
    transactionsExamined: transactionCache.size,
    missingTransactions: (await Promise.all(transactionCache.values())).filter(tx => !tx).length };
  history.coverage.note = 'Bounded mint and top-holder account histories; archival completeness and launch are not proven.';
  const events = [];
  for (const tx of history.transactions) {
    const balances = new Map();
    for (const [field, sign] of [['preTokenBalances', -1n], ['postTokenBalances', 1n]]) {
      for (const b of tx.meta[field] || []) if (b.mint === mintAddress && b.owner) balances.set(b.owner, (balances.get(b.owner) || 0n) + sign * raw(b.uiTokenAmount.amount));
    }
    const jito = instructions(tx).some(i => i.program === 'system' && i.parsed?.type === 'transfer' && JITO_TIP_ACCOUNTS.includes(i.parsed.info?.destination) && Number(i.parsed.info?.lamports) > 0);
    for (const [wallet, amount] of balances) if (amount > 0n) events.push({ wallet, amount, slot: tx.slot, jito });
  }
  events.sort((a, b) => a.slot - b.slot);
  const groups = [];
  for (let i = 0; i < events.length;) {
    const group = [events[i++]];
    while (i < events.length && events[i].slot - group.at(-1).slot <= 2) group.push(events[i++]);
    if (new Set(group.map(e => e.wallet)).size >= 2) groups.push(group);
  }
  const coordinatedWallets = [...new Set(groups.flat().map(e => e.wallet))];
  // Current balance exposure avoids counting repeated transfers of the same units as supply.
  const rpc = rpcClient('solana', options);
  const ownerAccounts = await mapLimit(basic.holders, 4, async h => ({ ...h, owner: (await rpc('getAccountInfo', [h.address, { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value?.data?.parsed?.info?.owner }));
  const exposure = ownerAccounts.filter(h => coordinatedWallets.includes(h.owner)).reduce((n, h) => n + raw(h.amount), 0n);
  const unresolved = ownerAccounts.filter(h => !h.owner);
  return { basic, chain: 'solana', address: mintAddress, bundledSupplyPct: groups.length && unresolved.length === basic.holders.length ? null : pct(exposure, raw(basic.supply)), bundleClusterCount: groups.length, coordinatedWallets, clusters: groups.map(g => ({ firstSlot: g[0].slot, lastSlot: g.at(-1).slot, wallets: [...new Set(g.map(e => e.wallet))], jitoTipObserved: g.some(e => e.jito) })), bundlerVerdict: groups.length ? 'COORDINATION_SUSPECTED' : 'INSUFFICIENT_EVIDENCE', coverage: { ...history.coverage, unresolvedHolderAccounts: unresolved.length, unresolvedSupplyPct: pct(unresolved.reduce((n, h) => n + raw(h.amount), 0n), raw(basic.supply)) }, limitations: ['Positive token deltas are acquisition candidates, not proven DEX buys.', 'Same-slot activity and Jito tips do not prove a shared controller or an atomic bundle.', 'bundledSupplyPct measures current top-account exposure to suspected wallets; it is a lower bound.'] };
}
export async function traceSolanaFundingClusters(holderAddresses, options = {}) {
  if (!Array.isArray(holderAddresses) || !holderAddresses.length || holderAddresses.length > 20) throw new Error('Provide 1–20 holder wallet addresses');
  const holders = [...new Set(holderAddresses.map(solanaAddress))], origins = [];
  const minFundingLamports = raw(options.minFundingLamports ?? 1_000_000);
  const rpc = rpcClient('solana', options);
  if (await rpc('getGenesisHash') !== SOLANA_GENESIS) throw new Error('Expected Solana mainnet genesis');
  const coverage = await mapLimit(holders, 3, async holder => {
    const h = await solanaHistory(holder, { ...options, maxPages: options.maxPages || 1, maxTransactions: options.maxTransactions || 10 });
    let origin, ignoredDustTransfers = 0;
    for (const tx of h.transactions) {
      for (const i of instructions(tx)) {
        if (i.program !== 'system' || i.parsed?.type !== 'transfer' || i.parsed.info?.destination !== holder || i.parsed.info.source === holder) continue;
        const lamports = raw(i.parsed.info.lamports);
        if (lamports < minFundingLamports) { ignoredDustTransfers++; continue; }
        if (!origin && lamports > 0n) origin = { holder, motherWallet: i.parsed.info.source, blockTime: tx.blockTime, slot: tx.slot };
      }
    }
    if (origin) origins.push(origin);
    return { holder, ...h.coverage, ignoredDustTransfers };
  });
  const groups = new Map();
  for (const o of origins) { if (!groups.has(o.motherWallet)) groups.set(o.motherWallet, []); groups.get(o.motherWallet).push(o); }
  const clusters = [...groups].filter(([, g]) => g.length >= 2).map(([motherWallet, g]) => ({ type: 'SHARED_FUNDER', motherWallet, holders: g.map(o => o.holder), synchronized: g.every(o => Number.isFinite(o.blockTime)) && Math.max(...g.map(o => o.blockTime)) - Math.min(...g.map(o => o.blockTime)) <= 60 }));
  const timed = origins.filter(o => Number.isFinite(o.blockTime)).sort((a, b) => a.blockTime - b.blockTime);
  for (let i = 0; i < timed.length;) {
    const g = [timed[i++]];
    while (i < timed.length && timed[i].blockTime - g.at(-1).blockTime <= 60) g.push(timed[i++]);
    if (g.length >= 2 && new Set(g.map(o => o.motherWallet)).size > 1) clusters.push({ type: 'TIMING_ONLY', holders: g.map(o => o.holder), synchronized: true, confidence: 'LOW' });
  }
  const linked = new Set(clusters.filter(c => c.type === 'SHARED_FUNDER').flatMap(c => c.holders));
  return { sybilClusterPct: Number((linked.size / holders.length * 100).toFixed(2)), denominator: 'Provided unique wallet count, not token supply', clusters, motherWallets: clusters.filter(c => c.motherWallet).map(c => c.motherWallet), coverage: { holders: coverage, ignoredDustTransfers: coverage.reduce((n, h) => n + h.ignoredDustTransfers, 0) }, limitations: ['Earliest observed inbound SOL transfer is not a proven original funder.', 'Shared exchanges and services can produce false positives; timing-only groups are excluded from sybilClusterPct.'] };
}
