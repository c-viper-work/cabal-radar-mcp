import { inferChain, solanaAddress, evmAddress, rpcClient, risk, flag, raw, pct, KNOWN_SOLANA_POOLS_AND_PROGRAMS, KNOWN_BASE_ROUTERS_AND_POOLS, EVM_RECIPIENT, BASE_USDC, MIN_ETH, MIN_USDC, verifyBasePaymentTx, verifySolanaPaymentTx, scanBaseTokenBasic, detectBaseEarlyBundlerAndHoneypot, detectSolanaBlock0Bundler, traceSolanaFundingClusters, inspectSolanaExtensions } from './scanner-core.js';
const yes = value => value === true || value === 1 || value === '1';
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const percent = value => { const n = number(value); return n === null ? null : n * 100; };
async function getJSON(url, fetcher) {
  const r = await fetcher(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('Provider unavailable');
  return r.json();
}
export async function scanLive(address, { fetch: fetcher = globalThis.fetch } = {}) {
  const chain = inferChain(address); (chain === 'base' ? evmAddress : solanaAddress)(address);
  const urls = { dex: `https://api.dexscreener.com/latest/dex/tokens/${address}`,
    security: chain === 'base' ? `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}` : `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`,
    ...(chain === 'solana' ? { rug: `https://api.rugcheck.xyz/v1/tokens/${address}/report` } : { honeypot: `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=8453` }) };
  const entries = Object.entries(urls);
  const settled = await Promise.allSettled([...entries.map(([, url]) => getJSON(url, fetcher)), ...(chain === 'base' ? [scanBaseTokenBasic(address, fetcher === globalThis.fetch ? {} : { fetch: fetcher })] : [])]);
  const sources = {}, errors = [];
  settled.forEach((r, i) => { const name = entries[i]?.[0] || 'rpc'; if (r.status === 'fulfilled') sources[name] = r.value; else errors.push(`${name}: unavailable (network, CORS or rate limit)`); });
  const pairs = (Array.isArray(sources.dex?.pairs) ? sources.dex.pairs : []).filter(p => p.chainId === chain && (chain === 'base' ? p.baseToken?.address?.toLowerCase() === address.toLowerCase() : p.baseToken?.address === address)).sort((a,b) => (number(b.liquidity?.usd) || 0) - (number(a.liquidity?.usd) || 0));
  const pair = pairs[0], rug = sources.rug;
  const security = sources.security?.result?.[address] || sources.security?.result?.[address.toLowerCase()];
  const flags = [...(sources.rpc?.flags || [])];
  const add = (code, penalty, detail) => { if (!flags.some(f => f.code === code)) flags.push(flag(code, penalty, detail)); };
  const holders = [];
  if (chain === 'solana' && Array.isArray(rug?.topHolders)) {
    for (const h of rug.topHolders.slice(0,20)) {
      try {
        let amount = null, share = number(h.pct);
        try { amount = raw(h.amount).toString(); share = pct(raw(amount), raw(rug.token?.supply)); } catch { /* Use provider percentage when raw JSON numbers would lose integer precision. */ }
        if (share !== null && (share < 0 || share > 100)) share = null;
        holders.push({ address: solanaAddress(h.address), owner: h.owner ? solanaAddress(h.owner) : null, amount, pct: share, insider: yes(h.insider), isPool: KNOWN_SOLANA_POOLS_AND_PROGRAMS.includes(h.owner) || KNOWN_SOLANA_POOLS_AND_PROGRAMS.includes(h.address) });
      } catch { /* Invalid addresses are not evidence. */ }
    }
  } else if (Array.isArray(security?.holders)) {
    for (const h of security.holders.slice(0,20)) holders.push({ address: h.address, owner: h.owner || h.address, pct: percent(h.percent), insider: yes(h.is_insider) || yes(h.is_creator), isPool: yes(h.is_pair) || (chain === 'base' ? KNOWN_BASE_ROUTERS_AND_POOLS.includes(h.address?.toLowerCase()) || h.address?.toLowerCase() === address.toLowerCase() : KNOWN_SOLANA_POOLS_AND_PROGRAMS.includes(h.owner)) });
  }
  const rugPools = new Set([...(rug?.markets || []).flatMap(m => [m?.pubkey, m?.liquidityA, m?.liquidityB, m?.mintLP]), ...Object.entries(rug?.knownAccounts || {}).filter(([, v]) => ['AMM', 'LP', 'LOCKER', 'VAULT', 'POOL'].includes(String(v?.type || '').toUpperCase()) || /\b(?:pool|amm|market|vault|lp|raydium|orca|whirlpool|meteora|pump)\b/i.test(String(v?.name || ''))).map(([k]) => k)].filter(Boolean));
  // Include pool addresses returned by indexers and PDA owner program checks; curated lists cannot enumerate every pool PDA.
  for (const h of holders) if (rugPools.has(h.address) || rugPools.has(h.owner) || pairs.some(p => [h.owner, h.address].some(a => a && p.pairAddress?.toLowerCase() === a.toLowerCase()))) h.isPool = true;
  if (chain === 'solana') {
    const dexPrograms = KNOWN_SOLANA_POOLS_AND_PROGRAMS.filter(p => !['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', '11111111111111111111111111111111'].includes(p));
    const owners = [...new Set(holders.filter(h => !h.isPool && h.owner).map(h => h.owner))];
    const info = owners.length ? await rpcClient('solana', fetcher === globalThis.fetch ? { maxRetries: 1 } : { fetch: fetcher })('getMultipleAccounts', [owners, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => null) : null;
    const pdaPools = new Set(owners.filter((_, i) => dexPrograms.includes(info?.value?.[i]?.owner)));
    for (const h of holders) if (pdaPools.has(h.owner)) h.isPool = true;
  }
  holders.sort((a,b) => (b.pct ?? -1) - (a.pct ?? -1));
  const nonPool = holders.filter(h => !h.isPool), known = nonPool.filter(h => h.pct !== null);
  const concentration = known.length ? Math.min(100, known.slice(0,10).reduce((n,h) => n + h.pct,0)) : null;
  if (concentration > 50) add('TOP10_CONCENTRATION',20,'Top ten sampled non-pool accounts hold over 50%');
  if (chain === 'solana') {
    if (rug?.token?.mintAuthority || yes(security?.mintable?.status)) add('MINT_AUTHORITY',25,'Mint authority may increase supply');
    if (rug?.token?.freezeAuthority || yes(security?.freezable?.status)) add('FREEZE_AUTHORITY',25,'Freeze authority may lock accounts');
    const extensions = rug?.token?.extensions || security?.extensions;
    if (Array.isArray(extensions)) for (const f of inspectSolanaExtensions(extensions).flags) add(f.code,f.penalty,f.detail);
    for (const r of rug?.risks || []) add(`RUGCHECK_${String(r.name)}`, r.level === 'danger' ? 25 : 10, String(r.description || r.name));
  }
  for (const [field, code, weight] of [['is_blacklisted','BLACKLIST',25],['is_proxy','PROXY',25],['is_mintable','MINT_AUTHORITY',25],['owner_change_balance','BALANCE_CONTROL',25],['cannot_sell_all','SELL_RESTRICTION',25]]) if (yes(security?.[field])) add(code, weight, `GoPlus reports ${field}`);
  let buyTax = percent(security?.buy_tax), sellTax = percent(security?.sell_tax);
  const hp = sources.honeypot;
  if (hp?.simulationResult) { buyTax = number(hp.simulationResult.buyTax); sellTax = number(hp.simulationResult.sellTax); }
  if (hp?.honeypotResult?.isHoneypot === true || yes(security?.is_honeypot)) add('HONEYPOT',80,'Provider simulation reports a honeypot');
  if (buyTax >= 10) add('HIGH_BUY_TAX',25,`Simulated buy tax ${buyTax}%`);
  if (sellTax >= 10) add('HIGH_SELL_TAX',25,`Simulated sell tax ${sellTax}%`);
  const hasSecurity = !!(sources.rpc || rug?.token || security && Object.keys(security).length);
  if (!hasSecurity) add('SECURITY_DATA_UNAVAILABLE',30,'Security providers unavailable; score cannot be established');
  if (!holders.length) add('HOLDER_DATA_UNAVAILABLE',15,'Holder concentration unavailable');
  const result = risk(flags);
  return { address, chain, generatedAt: new Date().toISOString(), name: pair?.baseToken?.name || rug?.tokenMeta?.name || security?.token_name || 'Unknown token', symbol: pair?.baseToken?.symbol || sources.rpc?.symbol || rug?.tokenMeta?.symbol || security?.token_symbol || '—',
    ...result, safetyScore: hasSecurity ? result.safetyScore : null, riskLevel: hasSecurity ? result.riskLevel : 'UNKNOWN', confidence: errors.length || !holders.length ? 'LOW' : 'HIGH',
    liquidity: number(pair?.liquidity?.usd), fdv: number(pair?.fdv), volume24h: number(pair?.volume?.h24), pairCreatedAt: number(pair?.pairCreatedAt), dex: pair?.dexId || null, buyTax, sellTax, concentration, holders,
    lpLockedPct: number(rug?.lpLockedPct) ?? number(rug?.markets?.find(m => m.pubkey === pair?.pairAddress)?.lp?.lpLockedPct) ?? percent(security?.lp_holders?.filter(h => yes(h.is_locked)).reduce((n,h) => n + (number(h.percent) || 0),0)),
    mintAuthority: rug?.token && Object.hasOwn(rug.token,'mintAuthority') ? rug.token.mintAuthority ?? 'Revoked' : 'Unknown', freezeAuthority: rug?.token && Object.hasOwn(rug.token,'freezeAuthority') ? rug.token.freezeAuthority ?? 'Revoked' : 'Unknown', extensions: rug?.token?.extensions || security?.extensions || [],
    sources: Object.keys(sources), errors, basic: sources.rpc || null, deep: null,
    limitations: ['Known pool exclusion is incomplete; accounts do not prove beneficial ownership.', 'Launch and shared controllers remain unverified until historical investigation; no score guarantees sellability.'] };
}
export async function verifyReceipt(receipt, options = {}) {
  const chain = /^0x/i.test(receipt) ? 'base' : 'solana';
  return (chain === 'base' ? verifyBasePaymentTx : verifySolanaPaymentTx)(receipt, options);
}
export function initScanner() {
  const $ = id => document.getElementById(id), storageKey = 'cabal-radar-browser-receipt-v1';
  let report, proof, scanId = 0, checking = false;
  const status = text => { $('scanner-status').textContent = text; };
  const money = n => n === null ? 'Unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact' }).format(n);
  const pc = n => n === null ? 'Unknown' : `${n.toFixed(2)}%`;
  const metric = (label, value) => { const div = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; div.append(dt, dd); $('risk-metrics').append(div); };
  function renderPro() {
    $('unlock-now').hidden = !!proof; $('pro-details').hidden = !proof; $('checkout').hidden = !!proof;
    $('pro-teaser').textContent = report ? `Detected ${report.holders.filter(h => !h.isPool).length} sampled non-pool accounts. Top ten hold ${pc(report.concentration)} of supply. ${proof ? 'Pro active: inspect owner evidence and run historical analysis below.' : 'Unlock Pro to inspect full reported owner addresses, insider flags, launch-window evidence and export reports.'}` : 'Scan a token to preview its holder evidence.';
    if (!proof || !report) return;
    $('holder-rows').replaceChildren();
    for (const h of report.holders.filter(h => !h.isPool)) {
      const tr = document.createElement('tr');
      for (const value of [h.owner || h.address, pc(h.pct), h.insider ? 'Provider flagged' : 'Not flagged']) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
      $('holder-rows').append(tr);
    }
    $('deep-result').textContent = report.deep ? JSON.stringify(report.deep,null,2) : 'Historical analysis not run. Reported account owners are not verified beneficial owners. Insider flags do not establish shared control.';
  }
  function render() {
    $('live-result').hidden = false; $('risk-title').textContent = `${report.name} / ${report.symbol}`;
    $('risk-score').textContent = report.safetyScore === null ? '—' : `${report.safetyScore}/100`;
    $('risk-level').textContent = `${report.riskLevel} · ${report.confidence} confidence`;
    $('risk-metrics').replaceChildren();
    metric('Liquidity', money(report.liquidity)); metric('FDV',money(report.fdv)); metric('24h volume',money(report.volume24h));
    metric('Pair age', report.pairCreatedAt ? `${Math.max(0,Math.floor((Date.now()-report.pairCreatedAt)/86400000))} days` : 'Unknown');
    metric('DEX / launchpad',report.dex || 'Unknown'); metric('Buy / sell tax',`${pc(report.buyTax)} / ${pc(report.sellTax)}`);
    metric('Top 10 non-pool',pc(report.concentration)); metric('LP locked',pc(report.lpLockedPct));
    if (report.chain === 'solana') { metric('Mint authority',report.mintAuthority); metric('Freeze authority',report.freezeAuthority); metric('Token extensions',Array.isArray(report.extensions) ? report.extensions.map(e => e.extension || 'Configured').join(', ') || 'None reported' : 'Unknown'); }
    else metric('Contract controls',report.flags.filter(f => ['BLACKLIST','PROXY','DELEGATECALL','OWNER_PRESENT','BALANCE_CONTROL','MINT_AUTHORITY','TRADING_TOGGLE','TX_LIMITS'].includes(f.code)).map(f => f.code).join(', ') || 'None detected / unproven');
    $('risk-flags').replaceChildren();
    for (const text of [...report.flags.map(f => f.detail), ...report.errors, ...report.limitations]) { const li = document.createElement('li'); li.textContent = text; $('risk-flags').append(li); }
    $('source-note').textContent = `${report.generatedAt} · Sources: ${report.sources.join(', ') || 'none'}`;
    renderPro();
  }
  async function scan() {
    const id = ++scanId; $('scan-button').disabled = true; status('Reading live market, security and chain evidence…');
    try { const next = await scanLive($('token-input').value.trim()); if (id !== scanId) return; report = next; render(); status(next.errors.length ? 'Partial results. Check provider coverage below.' : 'Live scan complete. Review the evidence and limitations.'); }
    catch (e) { status(e.message); }
    finally { if (id === scanId) $('scan-button').disabled = false; }
  }
  $('scan-form').addEventListener('submit', e => { e.preventDefault(); scan(); });
  $('token-input').addEventListener('input', () => { $('chain-badge').textContent = inferChain($('token-input').value.trim()).toUpperCase(); });
  for (const chip of document.querySelectorAll('[data-sample]')) chip.addEventListener('click', () => { $('token-input').value = chip.dataset.sample; $('chain-badge').textContent = inferChain(chip.dataset.sample).toUpperCase(); scan(); });
  $('unlock-now').addEventListener('click', () => { $('browser-pro').hidden = false; $('checkout').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('receipt-input').focus(); });
  async function activate(receipt) {
    const verified = await verifyReceipt(receipt); proof = verified;
    try { localStorage.setItem(storageKey, JSON.stringify({ txHash: verified.txHash })); } catch { /* Session activation still works without storage. */ }
    $('activation-command').textContent = `cabal-radar activate --tx ${verified.txHash} --chain ${verified.chain}`;
    $('checkout-status').textContent = 'Receipt verified on mainnet. Browser Pro active. Use this command to activate your machine-bound CLI license.';
    renderPro();
  }
  $('receipt-form').addEventListener('submit', async e => {
    e.preventDefault(); if (checking) return; checking = true; $('verify-receipt').disabled = true; $('checkout-status').textContent = 'Verifying confirmed receipt and official recipient…';
    try { await activate($('receipt-input').value.trim()); } catch (err) { $('checkout-status').textContent = `Not activated: ${err.message}. Retry after confirmation; public RPC may restrict browser access.`; }
    finally { checking = false; $('verify-receipt').disabled = false; }
  });
  for (const button of document.querySelectorAll('[data-pay]')) button.addEventListener('click', async () => {
    if (checking) return; checking = true;
    document.querySelectorAll('[data-pay]').forEach(b => { b.disabled = true; });
    try {
      if (!window.ethereum?.request) throw new Error('Install a compatible browser wallet, or verify an existing receipt below');
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] });
      if ((await window.ethereum.request({ method: 'eth_chainId' })).toLowerCase() !== '0x2105') throw new Error('Wallet must be on Base mainnet');
      const [from] = await window.ethereum.request({ method: 'eth_requestAccounts' }); evmAddress(from);
      const tx = button.dataset.pay === 'eth' ? { from, to: EVM_RECIPIENT, value: `0x${MIN_ETH.toString(16)}` } : { from, to: BASE_USDC, value: '0x0', data: `0xa9059cbb${EVM_RECIPIENT.slice(2).toLowerCase().padStart(64,'0')}${MIN_USDC.toString(16).padStart(64,'0')}` };
      const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
      $('receipt-input').value = hash; $('checkout-status').textContent = `Payment submitted: ${hash}. Waiting for confirmation…`;
      for (let i = 0; i < 12; i++) {
        try { await activate(hash); return; } catch { if (i === 11) throw new Error('Confirmation not yet available. Your receipt is shown below; retry verification without paying again'); }
        await new Promise(resolve => setTimeout(resolve,5000));
      }
    } catch (err) { $('checkout-status').textContent = err.message; }
    finally { checking = false; document.querySelectorAll('[data-pay]').forEach(b => { b.disabled = false; }); }
  });
  $('run-deep').addEventListener('click', async () => {
    if (!proof || !report) return;
    const current = report; $('run-deep').disabled = true; $('deep-result').textContent = 'Sampling historical RPC evidence; this may take a minute…';
    try {
      const deep = await (current.chain === 'base' ? detectBaseEarlyBundlerAndHoneypot : detectSolanaBlock0Bundler)(current.address, { ...(current.basic ? { basic: current.basic } : {}), maxPages: 1, maxTransactions: 20 });
      if (current.chain === 'solana') {
        const owners = [...new Set(current.holders.filter(h => !h.isPool && h.owner).map(h => h.owner))].slice(0,20);
        if (owners.length) deep.funding = await traceSolanaFundingClusters(owners, { maxPages: 1, maxTransactions: 5 }).catch(() => ({ status: 'UNAVAILABLE', reason: 'Funding history could not be fetched.' }));
      }
      current.deep = deep; if (report === current) renderPro();
    } catch (err) { if (report === current) $('deep-result').textContent = `Historical evidence unavailable: ${err.message}. No launch or funding conclusion can be drawn.`; }
    finally { $('run-deep').disabled = false; }
  });
  for (const b of document.querySelectorAll('[data-export]')) b.addEventListener('click', () => {
    if (!proof || !report) return;
    const markdown = b.dataset.export === 'markdown';
    const text = markdown ? `# Cabal Radar report\n\nGenerated: ${report.generatedAt}\n\nChain: ${report.chain}\n\nAddress: ${report.address}\n\nScore: ${report.safetyScore ?? 'UNKNOWN'} / 100\n\nFull evidence:\n\n\`\`\`json\n${JSON.stringify(report,null,2)}\n\`\`\`\n` : JSON.stringify(report,null,2);
    const url = URL.createObjectURL(new Blob([text],{ type: markdown ? 'text/markdown' : 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `cabal-radar-${report.chain}.${markdown ? 'md' : 'json'}`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  });
  // A stored flag is never accepted as proof. Reverify the receipt on each page load.
  try { const stored = JSON.parse(localStorage.getItem(storageKey)); if (stored?.txHash) activate(stored.txHash).catch(() => { $('checkout-status').textContent = 'Saved receipt could not be reverified. Retry verification to restore browser Pro.'; }); } catch { /* No stored receipt. */ }
}
