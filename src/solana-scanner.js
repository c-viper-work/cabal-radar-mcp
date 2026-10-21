import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, JITO_TIP_ACCOUNTS, SOLANA_GENESIS, KNOWN_SOLANA_POOLS_AND_PROGRAMS, KNOWN_SOLANA_EXCHANGE_WALLETS } from './constants.js';
import { rpcClient, solanaAddress, raw, pct, risk, flag, mapLimit, solanaTransaction, isRateLimit, enrichmentJson } from './rpc.js';
export async function scanSolanaTokenBasic(mintAddress, options = {}) {
  solanaAddress(mintAddress); const rpc = rpcClient('solana', options);
  if (await rpc('getGenesisHash') !== SOLANA_GENESIS) throw new Error('Expected Solana mainnet genesis');
  let holderDataUnavailable = false, holderDataSource = 'rpc';
  const [account, largest] = await Promise.all([
    rpc('getAccountInfo', [mintAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    rpc('getTokenLargestAccounts', [mintAddress, { commitment: 'confirmed' }]).catch(err => {
      if (err?.name === 'RpcError' && (isRateLimit(err) || [403, -32000, -32603].includes(err.code) || /HTTP 403|network failure|timeout/i.test(err.message))) {
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
  const extensionAnalysis = inspectSolanaExtensions(info.extensions);
  const dangerousExtensions = extensionAnalysis.dangerousExtensions; flags.push(...extensionAnalysis.flags);
  let holders = [], top10HolderPct = null, largestHolderPct = null;
  let holderRows = largest?.value;
  const rugPools = new Set(KNOWN_SOLANA_POOLS_AND_PROGRAMS);
  if (holderDataUnavailable && (!options.rpc || options.enrichmentFetch)) {
    try {
      const report = await enrichmentJson(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`, options);
      for (const m of report?.markets || []) for (const k of [m?.pubkey, m?.liquidityA, m?.liquidityB, m?.mintLP]) if (typeof k === 'string') rugPools.add(k);
      for (const [k, v] of Object.entries(report?.knownAccounts || {})) if (['AMM', 'LP', 'LOCKER', 'VAULT', 'POOL'].includes(String(v?.type || '').toUpperCase()) || /pool|amm|vault|raydium|orca|whirlpool|meteora|pump/i.test(String(v?.name || ''))) rugPools.add(k);
      if (Array.isArray(report?.topHolders) && report.topHolders.length) {
        holderRows = report.topHolders.map(h => {
          let amountStr;
          try { amountStr = raw(h.amount).toString(); }
          catch {
            const dec = Number.isInteger(h.decimals) ? h.decimals : info.decimals;
            if (typeof h.uiAmountString === 'string' && /^\d+(?:\.\d+)?$/.test(h.uiAmountString)) {
              const [w, f = ''] = h.uiAmountString.split('.');
              amountStr = BigInt(w + f.padEnd(dec, '0').slice(0, dec)).toString();
            } else if (Number.isFinite(Number(h.pct)) && Number(h.pct) >= 0 && Number(h.pct) <= 100) {
              amountStr = (supply * BigInt(Math.round(Number(h.pct) * 1e6)) / 100_000_000n).toString();
            } else throw new Error('Invalid holder amount');
          }
          const addr = solanaAddress(h.address), owner = h.owner ? solanaAddress(h.owner) : undefined;
          return { address: addr, amount: amountStr, owner, insider: h.insider === true, isPool: rugPools.has(addr) || (owner ? rugPools.has(owner) : false) };
        });
        holderDataUnavailable = false; holderDataSource = 'rugcheck-fallback';
      }
    } catch { /* Keep explicitly unavailable when enrichment fails validation. */ }
  }
  if (holderDataUnavailable) {
    flags.push(flag('HOLDER_DATA_UNAVAILABLE', 15, 'Largest-account query rate-limited or restricted by RPC; holder concentration not evaluated'));
  } else {
    if (!Array.isArray(holderRows)) throw new Error('Missing largest token accounts');
    const dexPoolPrograms = new Set(KNOWN_SOLANA_POOLS_AND_PROGRAMS.filter(p => ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, '11111111111111111111111111111111'].includes(p)));
    holders = holderRows.map(h => ({ ...h, address: h.address, amount: raw(h.amount).toString(), isPool: Boolean(h.isPool || rugPools.has(h.address) || (h.owner && rugPools.has(h.owner))) })).sort((a, b) => raw(a.amount) > raw(b.amount) ? -1 : raw(a.amount) < raw(b.amount) ? 1 : 0);
    if (holders.some(h => !h.owner) && holders.length) {
      const acctRes = await rpc('getMultipleAccounts', [holders.map(h => h.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => null);
      if (Array.isArray(acctRes?.value)) holders.forEach((h, i) => {
        const owner = acctRes.value[i]?.data?.parsed?.info?.owner;
        if (typeof owner === 'string') { h.owner = owner; if (rugPools.has(owner)) h.isPool = true; }
      });
    }
    const uniqueOwners = [...new Set(holders.map(h => h.owner).filter(Boolean))];
    if (uniqueOwners.length) {
      const ownerRes = await rpc('getMultipleAccounts', [uniqueOwners, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => null);
      if (Array.isArray(ownerRes?.value)) {
        const pdaPoolOwners = new Set(uniqueOwners.filter((_, i) => dexPoolPrograms.has(ownerRes.value[i]?.owner)));
        for (const h of holders) if (h.owner && pdaPoolOwners.has(h.owner)) h.isPool = true;
      }
    }
    top10HolderPct = pct(holders.slice(0, 10).reduce((n, h) => n + raw(h.amount), 0n), supply);
    largestHolderPct = pct(holders.length ? raw(holders[0].amount) : 0n, supply);
    const nonPool = holders.filter(h => !h.isPool);
    if (nonPool.slice(0, 10).reduce((n, h) => n + raw(h.amount), 0n) * 100n > supply * 50n) flags.push(flag('TOP10_CONCENTRATION', 20, 'Top ten non-pool token accounts hold over half the supply; unindexed pools or vaults may remain'));
    if ((nonPool.length ? raw(nonPool[0].amount) : 0n) * 100n > supply * 20n) flags.push(flag('LARGE_ACCOUNT', 15, 'Largest token account exceeds 20% of supply'));
  }
  if (supply === 0n) flags.push(flag('ZERO_SUPPLY', 40, 'No circulating token supply to assess'));
  return { chain: 'solana', address: mintAddress, holderDataUnavailable, holderDataSource, confidence: holderDataUnavailable ? 'LOW' : 'HIGH', supply: supply.toString(), decimals: info.decimals, mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null, isToken2022: value.owner === TOKEN_2022_PROGRAM_ID, dangerousExtensions, top10HolderPct, largestHolderPct, holders, ...risk(flags), proPreview: 'Account concentration can hide shared funding. Pro samples early acquisitions, Jito tips and common funding origins.', limitations: ['Holder percentages are token-account concentration, not beneficial ownership.', 'Liquidity locks, pool ownership and sellability are not verified.'] };
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
    if (!transactionCache.has(s.signature)) transactionCache.set(s.signature, (async () => {
      try { return await solanaTransaction(rpc, s.signature); }
      catch (err) {
        if (err?.name === 'RpcError' && (err.code === -32015 || isRateLimit(err) || /timeout|network|version/i.test(err.message))) return null;
        throw err;
      }
    })());
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
  const poolPdas = new Set(KNOWN_SOLANA_POOLS_AND_PROGRAMS);
  for (const h of basic.holders || []) if (h.isPool && h.owner) poolPdas.add(h.owner);
  const earliestGain = new Map(), earliestPoolOut = new Map();
  const parsedTxs = history.transactions.map(tx => {
    const balances = new Map();
    for (const [field, sign] of [['preTokenBalances', -1n], ['postTokenBalances', 1n]]) {
      for (const b of tx.meta[field] || []) if (b.mint === mintAddress && b.owner) balances.set(b.owner, (balances.get(b.owner) || 0n) + sign * raw(b.uiTokenAmount.amount));
    }
    const keys = tx.transaction?.message?.accountKeys || [];
    const signers = new Set(keys.filter(k => k?.signer === true).map(k => k.pubkey));
    const payer = keys.find(k => k?.signer === true)?.pubkey || (typeof keys[0] === 'string' ? keys[0] : keys[0]?.pubkey) || null;
    for (const [wallet, amount] of balances) {
      if (amount > 0n && (!earliestGain.has(wallet) || tx.slot < earliestGain.get(wallet))) earliestGain.set(wallet, tx.slot);
      if (amount < 0n && !signers.has(wallet) && (!earliestPoolOut.has(wallet) || tx.slot < earliestPoolOut.get(wallet))) earliestPoolOut.set(wallet, tx.slot);
    }
    return { tx, balances, signers, payer };
  });
  for (const [wallet, outSlot] of earliestPoolOut) if (!earliestGain.has(wallet) || outSlot <= earliestGain.get(wallet)) poolPdas.add(wallet);
  const events = [];
  for (const { tx, balances, signers, payer } of parsedTxs) {
    const jito = instructions(tx).some(i => i.program === 'system' && i.parsed?.type === 'transfer' && JITO_TIP_ACCOUNTS.includes(i.parsed.info?.destination) && Number(i.parsed.info?.lamports) > 0);
    const hasSignerSeller = signers.size > 0 && [...signers].some(s => (balances.get(s) || 0n) < 0n);
    const nonPoolNonSigners = [...balances].filter(([wallet, amount]) => amount > 0n && !poolPdas.has(wallet) && !signers.has(wallet));
    const buyers = [...balances].filter(([wallet, amount]) => {
      if (amount <= 0n || poolPdas.has(wallet)) return false;
      if (hasSignerSeller && !signers.has(wallet) && nonPoolNonSigners.length === 1) return false;
      return true;
    });
    for (const [wallet, amount] of buyers) events.push({ wallet, amount, slot: tx.slot, jito, payer, txBuyers: buyers.length });
  }
  events.sort((a, b) => a.slot - b.slot);
  const groups = [];
  for (let i = 0; i < events.length;) {
    const group = [events[i++]];
    while (i < events.length && (events[i].slot - group[0].slot <= 2 || (events[i].slot - group.at(-1).slot <= 2 && events[i].payer && group.some(e => e.payer === events[i].payer)))) group.push(events[i++]);
    const wallets = new Set(group.map(e => e.wallet));
    const payerWallets = new Map();
    const slotWallets = new Map();
    for (const e of group) {
      if (e.payer) { if (!payerWallets.has(e.payer)) payerWallets.set(e.payer, new Set()); payerWallets.get(e.payer).add(e.wallet); }
      if (!slotWallets.has(e.slot)) slotWallets.set(e.slot, new Set());
      slotWallets.get(e.slot).add(e.wallet);
    }
    const sharedPayer = [...payerWallets.values()].some(set => set.size >= 2);
    const sameSlotThree = [...slotWallets.values()].some(set => set.size >= 3);
    if (wallets.size >= 2 && (sameSlotThree || sharedPayer || group.some(e => e.txBuyers >= 2))) groups.push(group);
  }
  const coordinatedWallets = [...new Set(groups.flat().map(e => e.wallet).filter(w => !poolPdas.has(w)))];
  // Current balance exposure avoids counting repeated transfers of the same units as supply.
  const rpc = rpcClient('solana', options);
  const ownerAccounts = await mapLimit(basic.holders, 4, async h => ({ ...h, owner: h.owner || (await rpc('getAccountInfo', [h.address, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => null))?.value?.data?.parsed?.info?.owner }));
  const exposure = ownerAccounts.filter(h => coordinatedWallets.includes(h.owner)).reduce((n, h) => n + raw(h.amount), 0n);
  const unresolved = ownerAccounts.filter(h => !h.owner);
  return { basic, chain: 'solana', address: mintAddress, bundledSupplyPct: !basic.holders.length || unresolved.length === basic.holders.length ? null : pct(exposure, raw(basic.supply)), bundleClusterCount: groups.length, coordinatedWallets, clusters: groups.map(g => ({ firstSlot: g[0].slot, lastSlot: g.at(-1).slot, wallets: [...new Set(g.map(e => e.wallet))], jitoTipObserved: g.some(e => e.jito) })), bundlerVerdict: groups.length ? 'COORDINATION_SUSPECTED' : history.coverage.historyExhausted ? 'INSUFFICIENT_EVIDENCE' : 'LAUNCH_NOT_REACHED', coverage: { ...history.coverage, launchWindowReached: history.coverage.historyExhausted, unresolvedHolderAccounts: unresolved.length, unresolvedSupplyPct: pct(unresolved.reduce((n, h) => n + raw(h.amount), 0n), raw(basic.supply)) }, limitations: ['Positive token deltas are acquisition candidates, not proven DEX buys.', 'Same-slot activity and Jito tips do not prove a shared controller or an atomic bundle.', 'bundledSupplyPct measures current top-account exposure to suspected wallets; it is a lower bound.'] };
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
  const exchangeFundedGroups = [...groups].filter(([wallet]) => KNOWN_SOLANA_EXCHANGE_WALLETS.includes(wallet)).map(([exchangeWallet, g]) => ({ exchangeWallet, holders: g.map(o => o.holder) }));
  const clusters = [...groups].filter(([wallet, g]) => g.length >= 2 && !KNOWN_SOLANA_EXCHANGE_WALLETS.includes(wallet)).map(([motherWallet, g]) => ({ type: 'SHARED_FUNDER', motherWallet, holders: g.map(o => o.holder), synchronized: g.every(o => Number.isFinite(o.blockTime)) && Math.max(...g.map(o => o.blockTime)) - Math.min(...g.map(o => o.blockTime)) <= 60 }));
  const timed = origins.filter(o => Number.isFinite(o.blockTime)).sort((a, b) => a.blockTime - b.blockTime);
  for (let i = 0; i < timed.length;) {
    const g = [timed[i++]];
    while (i < timed.length && timed[i].blockTime - g.at(-1).blockTime <= 60) g.push(timed[i++]);
    if (g.length >= 2 && new Set(g.map(o => o.motherWallet)).size > 1) clusters.push({ type: 'TIMING_ONLY', holders: g.map(o => o.holder), synchronized: true, confidence: 'LOW' });
  }
  const linked = new Set(clusters.filter(c => c.type === 'SHARED_FUNDER').flatMap(c => c.holders));
  return { exchangeFundedGroups, sybilClusterPct: Number((linked.size / holders.length * 100).toFixed(2)), denominator: 'Provided unique wallet count, not token supply', clusters, motherWallets: clusters.filter(c => c.motherWallet).map(c => c.motherWallet), coverage: { holders: coverage, ignoredDustTransfers: coverage.reduce((n, h) => n + h.ignoredDustTransfers, 0) }, limitations: ['Earliest observed inbound SOL transfer is not a proven original funder.', 'Shared exchanges and services can produce false positives; timing-only groups are excluded from sybilClusterPct.'] };
}

export function inspectSolanaExtensions(extensions) {
  const flags = [];
  const dangerousExtensions = [];
  for (const e of extensions || []) {
    const name = e.extension;
    if (['scaledUiAmountConfig', 'interestBearingConfig'].includes(name) && (e.state?.authority != null || e.state?.rateAuthority != null)) { dangerousExtensions.push(e); flags.push(flag('BALANCE_MANIPULATION_EXTENSION', 25, 'Extension authority can rescale or alter displayed balances')); }
    if (name === 'mintCloseAuthority' && e.state?.closeAuthority != null) { dangerousExtensions.push(e); flags.push(flag('MINT_CLOSE_AUTHORITY', 15, 'Close authority can close the mint account if supply reaches zero')); }
    if (name === 'confidentialTransferMint' && (e.state?.authority != null || e.state?.auditorElGamalPubkey != null || e.state?.auditorElgamalPubkey != null)) { dangerousExtensions.push(e); flags.push(flag('CONFIDENTIAL_TRANSFER_CONTROL', 15, 'Confidential transfer authority or auditor configured')); }
    if ((name === 'permanentDelegate' && (!e.state || e.state.delegate != null)) || (name === 'transferHook' && (e.state?.programId || e.state?.authority))) { dangerousExtensions.push(e); flags.push(flag(name, 25, 'Extended transfer or delegate control')); }
    if (name === 'nonTransferable') { dangerousExtensions.push(e); flags.push(flag('NON_TRANSFERABLE', 35, 'Token-2022 nonTransferable extension prevents standard transfers')); }
    if (['pausableConfig', 'pausable'].includes(name) && (e.state?.paused === true || e.state?.authority != null)) { dangerousExtensions.push(e); flags.push(flag('PAUSABLE', e.state?.paused === true ? 35 : 20, e.state?.paused === true ? 'Token transfers are paused' : 'Pause authority can stop token transfers')); }
    if (name === 'transferFeeConfig') {
      const bps = Math.max(Number(e.state?.newerTransferFee?.transferFeeBasisPoints || 0), Number(e.state?.olderTransferFee?.transferFeeBasisPoints || 0));
      if (bps < 1000 && e.state?.transferFeeConfigAuthority != null) { dangerousExtensions.push(e); flags.push(flag('MUTABLE_TRANSFER_FEE', 15, 'Transfer fee authority can raise fees up to the configured cap')); }
      else if (bps > 0 && bps < 1000) { dangerousExtensions.push(e); flags.push(flag('NONZERO_TRANSFER_FEE', 10, `Configured fixed transfer fee of ${bps / 100}%`)); }
      if (bps >= 1000) { dangerousExtensions.push(e); flags.push(flag('HIGH_TRANSFER_FEE', 25, `Configured fee up to ${bps / 100}% before maximum-fee cap`)); }
    }
    if (name === 'defaultAccountState' && [e.state?.accountState, e.state?.state].some(state => String(state).toLowerCase() === 'frozen')) { dangerousExtensions.push(e); flags.push(flag('DEFAULT_FROZEN', 30, 'New token accounts start frozen')); }
  }
  return { flags, dangerousExtensions };
}
