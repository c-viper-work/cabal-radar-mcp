import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createHash, createHmac } from 'node:crypto';
import { hostname, homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import * as C from '../src/constants.js';
import { rpcClient, RpcError, inferChain, raw } from '../src/rpc.js';
import { verifyBasePaymentTx, verifySolanaPaymentTx } from '../src/payments.js';
import { getMachineChallenge, loadLicense, saveLicense } from '../src/license.js';
import { solanaHistory, scanSolanaTokenBasic, detectSolanaBlock0Bundler, traceSolanaFundingClusters } from '../src/solana-scanner.js';
import { inspectBytecode, scanBaseTokenBasic, detectBaseEarlyBundlerAndHoneypot } from '../src/base-scanner.js';
import { callTool } from '../src/service.js';
import { selector } from '../src/keccak.js';
import { browserSource } from '../scripts/build-browser.mjs';
import { testTemp } from './temp.js';
import { HASH, SIG, MINT, WALLET, OTHER, THIRD, ADDRESS, word, topic, solTx, solScanRpc, baseScanRpc, basePayment, usdcLog, tokenBalance } from './fixtures.js';
const codes = r => r.flags.map(f => f.code);
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('version 1 Solana payment fallback, with identical confirmation and encoding', async () => {
  const versions = [];
  const proof = await verifySolanaPaymentTx(SIG, { rpc: async (m,p) => {
    if (m === 'getGenesisHash') return C.SOLANA_GENESIS;
    versions.push(p[1].maxSupportedTransactionVersion);
    assert.equal(p[1].commitment,'confirmed'); assert.equal(p[1].encoding,'jsonParsed');
    if (!p[1].maxSupportedTransactionVersion) throw new RpcError('version unsupported',-32015);
    return solTx();
  } });
  assert.equal(proof.verified,true); assert.deepEqual(versions,[0,1]);
});
test('history falls back to v1 and caches missing transactions without rejecting whole scan', async () => {
  const calls = [], cache = new Map();
  const rpc = async (m,p) => {
    if (m === 'getSignaturesForAddress') return ['v1','limited','network'].map(signature => ({signature,slot:1,err:null}));
    calls.push([p[0],p[1].maxSupportedTransactionVersion]);
    if (p[0] === 'limited') throw new RpcError('limited',429);
    if (p[0] === 'network') throw new RpcError('network failure or timeout');
    if (p[1].maxSupportedTransactionVersion === 0) throw new RpcError('version',-32015);
    return solTx();
  };
  const history = await solanaHistory(MINT,{rpc},cache);
  assert.equal(history.transactions.length,1); assert.equal(history.coverage.missingTransactions,2);
  assert.deepEqual(calls.filter(c=>c[0]==='v1').map(c=>c[1]),[0,1]);
  await solanaHistory(MINT,{rpc},cache); assert.equal(calls.length,4);
  await assert.rejects(solanaHistory(MINT,{rpc: async m => m === 'getSignaturesForAddress' ? [{signature:'x',slot:1,err:null}] : Promise.reject(new Error('programming error'))}),/programming error/);
});
test('persistent v1 version errors are missing, including bundler cache aggregation', async () => {
  const fixture=solScanRpc({history:[{signature:SIG,slot:1,err:null}]});
  const r=await detectSolanaBlock0Bundler(MINT,{rpc:async(m,p)=>m==='getTransaction'?Promise.reject(new RpcError('unsupported',-32015)):fixture(m,p)});
  assert.equal(r.coverage.missingTransactions,1); assert.equal(r.bundlerVerdict,'INSUFFICIENT_EVIDENCE');
});
test('bundler excludes known programs and seller-to-nonsigner-pool gains', async () => {
  const pool=C.KNOWN_SOLANA_POOLS_AND_PROGRAMS[3];
  const transaction=solTx({transaction:{message:{accountKeys:[{pubkey:WALLET,signer:true}],instructions:[]}},meta:{preTokenBalances:[tokenBalance(WALLET,100)],postTokenBalances:[tokenBalance(OTHER,50),tokenBalance(pool,50)]}});
  const rpc=solScanRpc({history:[{signature:SIG,slot:10,err:null}],transactions:{[SIG]:transaction}});
  const r=await detectSolanaBlock0Bundler(MINT,{rpc});
  assert.deepEqual(r.coordinatedWallets,[]); assert.equal(r.bundleClusterCount,0); assert.equal(r.coverage.launchWindowReached,true);
  transaction.transaction.message.accountKeys=[];
  const known=await detectSolanaBlock0Bundler(MINT,{rpc}); assert.deepEqual(known.coordinatedWallets,[]);
});
test('bundler keeps signer buys, reuses owner evidence and tolerates account resolution failure', async () => {
  const tx=solTx({transaction:{message:{accountKeys:[{pubkey:WALLET,signer:true},{pubkey:OTHER,signer:true}],instructions:[]}},meta:{preTokenBalances:[tokenBalance(THIRD,100)],postTokenBalances:[tokenBalance(WALLET,50),tokenBalance(OTHER,50)]}});
  const rpc=solScanRpc({history:[{signature:SIG,slot:10,err:null}],transactions:{[SIG]:tx}});
  const basic={supply:'1000',holders:[{address:OTHER,owner:WALLET,amount:'100'},{address:THIRD,amount:'200'}]};
  let lookups=0;
  const r=await detectSolanaBlock0Bundler(MINT,{basic,rpc:async(m,p)=>{if(m==='getAccountInfo'){lookups++;throw new RpcError('limited',429);}return rpc(m,p);}});
  assert.equal(lookups,1); assert.equal(r.bundledSupplyPct,10); assert.equal(r.coverage.unresolvedHolderAccounts,1);
  for(const holders of [[],[{address:OTHER,amount:'10'}]]) {
    const empty=await detectSolanaBlock0Bundler(MINT,{basic:{supply:'1000',holders},rpc:async(m,p)=>m==='getAccountInfo'?null:rpc(m,p)});
    assert.equal(empty.bundledSupplyPct,null);
  }
});
test('CEX shared funding is separate from sybil clusters', async () => {
  const source=C.KNOWN_SOLANA_EXCHANGE_WALLETS[0], holders=[WALLET,OTHER];
  const rpc=solScanRpc({history:p=>[{signature:p[0],slot:10,err:null}],transactions:Object.fromEntries(holders.map(h=>[h,solTx({transaction:{message:{instructions:[{program:'system',parsed:{type:'transfer',info:{source,destination:h,lamports:2000000}}}]}}})]))});
  const r=await traceSolanaFundingClusters(holders,{rpc});
  assert.equal(r.sybilClusterPct,0); assert.deepEqual(r.clusters,[]); assert.deepEqual(r.exchangeFundedGroups,[{exchangeWallet:source,holders}]);
});
for(const [extension,state,code] of [['scaledUiAmountConfig',{authority:WALLET},'BALANCE_MANIPULATION_EXTENSION'],['interestBearingConfig',{rateAuthority:WALLET},'BALANCE_MANIPULATION_EXTENSION'],['mintCloseAuthority',{closeAuthority:WALLET},'MINT_CLOSE_AUTHORITY'],['confidentialTransferMint',{auditorElGamalPubkey:WALLET},'CONFIDENTIAL_TRANSFER_CONTROL']]) test(`Token-2022 ${extension} active vs revoked`,async()=>{
  assert.ok(codes(await scanSolanaTokenBasic(MINT,{rpc:solScanRpc({info:{extensions:[{extension,state}]}})})).includes(code));
  assert.ok(!codes(await scanSolanaTokenBasic(MINT,{rpc:solScanRpc({info:{extensions:[{extension,state:{}}]}})})).includes(code));
});
test('holder fallback is explicit and failures remain LOW confidence', async () => {
  const base=solScanRpc(),rpc=async(m,p)=>m==='getTokenLargestAccounts'?Promise.reject(new RpcError('limit',429)):base(m,p);
  const unavailable=await scanSolanaTokenBasic(MINT,{rpc}); assert.equal(unavailable.confidence,'LOW');
  const r=await scanSolanaTokenBasic(MINT,{rpc,enrichmentFetch:async()=>json({topHolders:[{address:OTHER,owner:C.KNOWN_SOLANA_POOLS_AND_PROGRAMS[3],amount:'100',insider:false},{address:THIRD,owner:WALLET,amount:'100'}]})});
  assert.equal(r.holderDataSource,'rugcheck-fallback'); assert.equal(r.holderDataUnavailable,false); assert.equal(r.confidence,'HIGH'); assert.equal(r.top10HolderPct,20); assert.equal(r.holders[0].isPool,true);
  const invalid=await scanSolanaTokenBasic(MINT,{rpc,enrichmentFetch:async()=>json({topHolders:[{address:OTHER,amount:-1}]})}); assert.equal(invalid.confidence,'LOW');
});
test('EIP-7702 designator reports delegated account without parsing address bytes as opcodes',()=>{
  const r=inspectBytecode(`0xef0100${'ff'.repeat(20)}`); assert.deepEqual(codes(r),['EIP7702_DELEGATED_ACCOUNT']); assert.equal(r.delegatedTo,`0x${'ff'.repeat(20)}`); assert.deepEqual(r.selectors,[]);
});
for(const mode of ['1167','1967','zeppelin']) test(`proxy ${mode} implementation controls are propagated`,async()=>{
  const implementation=`0x${'34'.repeat(20)}`, code=mode==='1167'?`0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`:'0xf4';
  const fixture=baseScanRpc({code}); let storageReads=0;
  const r=await scanBaseTokenBasic(ADDRESS,{rpc:async(m,p)=>{
    if(m==='eth_getStorageAt'){storageReads++;return mode==='zeppelin'&&storageReads===1?`0x${word(0)}`:topic(implementation);}
    if(m==='eth_getCode'&&p[0]===implementation)return `0x63${selector('setBots(address[])')}63${selector('setMaxTxAmount(uint256)')}`;
    return fixture(m,p);
  }});
  assert.equal(r.implementationAddress,implementation); assert.ok(codes(r).includes('BLACKLIST')); assert.ok(codes(r).includes('TX_LIMITS')); assert.equal(storageReads,mode==='1167'?0:mode==='zeppelin'?2:1);
});
for(const [signature,code] of [['setBots(address[])','BLACKLIST'],['addBot(address)','BLACKLIST'],['setMaxTxAmount(uint256)','TX_LIMITS'],['setMaxWalletSize(uint256)','TX_LIMITS'],['openTrading()','TRADING_TOGGLE'],['enableTrading()','TRADING_TOGGLE']]) test(`selector ${signature}`,()=>assert.ok(codes(inspectBytecode(`0x63${selector(signature)}`)).includes(code)));
test('Base excludes router/self recipients and preserves logs before a rate limit',async()=>{
  const logs=[C.KNOWN_BASE_ROUTERS_AND_POOLS.at(-1),ADDRESS,C.EVM_RECIPIENT].map((to,i)=>({address:ADDRESS,topics:[C.TRANSFER_TOPIC,topic(`0x${'56'.repeat(20)}`),topic(to)],data:`0x${word(10)}`,blockNumber:'0x1',transactionHash:HASH,logIndex:`0x${i}`}));
  const fixture=baseScanRpc({latest:'0x400',logs});let queries=0;
  const r=await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{rpc:async(m,p)=>{if(m==='eth_getLogs'&&++queries>1)throw new RpcError('RPC HTTP 429');return fixture(m,p);}});
  assert.equal(r.earlyWalletCount,1);assert.deepEqual(r.coordinatedWallets,[C.EVM_RECIPIENT.toLowerCase()]);assert.equal(r.coverage.logQueryRateLimited,true);assert.equal(r.coverage.transferCount,3);
});
test('honeypot enrichment validates results and reports high taxes',async()=>{
  for(const [isHoneypot,sellTax,expected] of [[true,0,'HIGH_RISK_HONEYPOT'],[false,12,'REVIEW_REQUIRED']]) {
    const r=await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{rpc:baseScanRpc(),enrichmentFetch:async()=>json({simulationResult:{buyTax:0,sellTax},honeypotResult:{isHoneypot}})});
    assert.equal(r.transferTax.status,'SIMULATED_VIA_API');assert.equal(r.honeypotVerdict,expected);
  }
  const invalid=await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{rpc:baseScanRpc(),enrichmentFetch:async()=>json({simulationResult:{buyTax:null,sellTax:'bad'},honeypotResult:{isHoneypot:false}})});assert.equal(invalid.transferTax.status,'UNKNOWN');
});
test('USDC split logs sum exactly; malformed, removed, wrong recipient/token and underpayment fail',async()=>{
  const verify=logs=>verifyBasePaymentTx(HASH,{rpc:basePayment({tx:{to:ADDRESS,value:'0x0'},receipt:{logs}})});
  const proof=await verify([usdcLog(7000000n),usdcLog(8000000n)]); assert.equal(proof.amount,'15000000');assert.equal(proof.asset,'USDC');
  for(const bad of [{...usdcLog(8000000n),removed:true},{...usdcLog(8000000n),address:ADDRESS},{...usdcLog(8000000n),topics:[C.TRANSFER_TOPIC,topic(ADDRESS),topic(ADDRESS)]},usdcLog(7999999n),{...usdcLog(8000000n),data:'0x1'}])await assert.rejects(verify([usdcLog(7000000n),bad]));
  await assert.rejects(verify([usdcLog(),{...usdcLog(),data:'0x1'}]));
});
test('machine identity is stable, salt-sensitive and honors explicit container ID',()=>{
  const salt='a', expected=createHash('sha256').update(JSON.stringify(['cabal-radar-v1',process.env.CABAL_RADAR_MACHINE_ID||homedir(),platform(),arch(),salt])).digest('hex').slice(0,12);
  assert.equal(getMachineChallenge(salt).machine_id,expected);assert.deepEqual(getMachineChallenge(salt),getMachineChallenge(salt));assert.notDeepEqual(getMachineChallenge('a'),getMachineChallenge('b'));
  const old=process.env.CABAL_RADAR_MACHINE_ID;
  try {process.env.CABAL_RADAR_MACHINE_ID='persistent-container';assert.notEqual(getMachineChallenge().machine_id,getMachineChallenge('a').machine_id);assert.deepEqual(getMachineChallenge(),getMachineChallenge());}finally{if(old===undefined)delete process.env.CABAL_RADAR_MACHINE_ID;else process.env.CABAL_RADAR_MACHINE_ID=old;}
});
test('legacy machine license still verifies its original HMAC; altered salts fail',async t=>{
  if(process.env.CABAL_RADAR_MACHINE_ID)return;
  const dir=await testTemp('cabal-legacy-');t.after(()=>rm(dir,{recursive:true,force:true}));const licensePath=join(dir,'license.json');
  const machine_id=createHash('sha256').update(JSON.stringify(['cabal-radar-v1',hostname(),homedir(),platform(),arch(),''])).digest('hex').slice(0,12);
  const r={version:1,machine_id,txHash:HASH,chain:'base'};
  r.integrity=createHmac('sha256',createHash('sha256').update(`cabal-radar-integrity-v1:${machine_id}`).digest()).update(JSON.stringify([r.version,r.machine_id,r.txHash,r.chain])).digest('hex');await writeFile(licensePath,JSON.stringify(r));
  assert.ok(await loadLicense({licensePath}));assert.equal(await loadLicense({licensePath,customSalt:'different'}),null);
});
test('RPC retries transient errors only when enabled and cancellation stops backoff',async()=>{
  for(const code of [429,503,-32005,-32011,-32012]) {
    let count=0;const rpc=rpcClient('base',{maxRetries:1,rpc:async()=>{if(++count===1)throw new RpcError('limited',code);return 42;}});
    assert.equal(await rpc('method'),42);assert.equal(count,2);
  }
  let count=0;await assert.rejects(rpcClient('base',{rpc:async()=>{count++;throw new RpcError('limited',429);}})('method'));assert.equal(count,1);
  const controller=new AbortController();const pending=rpcClient('base',{maxRetries:2,signal:controller.signal,rpc:async()=>{setTimeout(()=>controller.abort(),5);throw new RpcError('limited',429);}})('method');await assert.rejects(pending,{name:'AbortError'});
  assert.equal(raw('0xffff'),65535n);for(const v of [-1,1.1,Number.MAX_SAFE_INTEGER+1,'-1','1e6'])assert.throws(()=>raw(v));
});
test('live global fetch retries HTTP 503 by default',async t=>{
  let count=0;t.mock.method(globalThis,'fetch',async(_,o)=>++count===1?new Response('',{status:503}):json({jsonrpc:'2.0',id:JSON.parse(o.body).id,result:9}));
  assert.equal(await rpcClient('base')('method'),9);assert.equal(count,2);
});
test('Worker preflight, all-response CORS, receipt cache and injected bypass',async t=>{
  const {handleRequest}=await import('../cloud-worker/worker.js?regression-cache');
  for(const path of ['/health','/scan']){const r=await handleRequest(new Request(`https://test.invalid${path}`,{method:'OPTIONS'}));assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),'*');assert.match(r.headers.get('access-control-allow-headers'),/x-payment-tx/);}
  const missing=await handleRequest(new Request('https://test.invalid/nope'));assert.equal(missing.headers.get('access-control-allow-origin'),'*');
  let reads=0;const fixture=basePayment();t.mock.method(globalThis,'fetch',async(_,o)=>{reads++;const q=JSON.parse(o.body);return json({jsonrpc:'2.0',id:q.id,result:await fixture(q.method,q.params)});});
  const request=()=>new Request('https://test.invalid/scan',{method:'POST',headers:{'x-payment-tx':HASH,'x-payment-chain':'base'}});
  assert.equal((await handleRequest(request())).status,415);assert.equal((await handleRequest(request())).status,415);assert.equal(reads,3);
  let injectedReads=0;for(let i=0;i<2;i++)await handleRequest(request(),{},{paymentOptions:{rpc:async(m,p)=>{injectedReads++;return fixture(m,p);}}});assert.equal(injectedReads,6);
});
test('Worker receipt cache bounded to 256 successful proofs',async t=>{
  const {handleRequest}=await import('../cloud-worker/worker.js?bounded-cache');let reads=0;
  t.mock.method(globalThis,'fetch',async(_,o)=>{reads++;const q=JSON.parse(o.body),hash=q.params?.[0]||HASH;const f=basePayment({tx:{hash},receipt:{transactionHash:hash}});return json({jsonrpc:'2.0',id:q.id,result:await f(q.method)});});
  const request=i=>new Request('https://test.invalid/scan',{method:'POST',headers:{'x-payment-chain':'base','x-payment-tx':`0x${word(i)}`}});
  for(let i=0;i<257;i++)assert.equal((await handleRequest(request(i))).status,415);
  const before=reads;await handleRequest(request(256));assert.equal(reads,before);await handleRequest(request(0));assert.equal(reads,before+3);
});
test('callTool and CLI infer Base while explicit invalid chains fail',async t=>{
  assert.equal(inferChain(ADDRESS),'base');assert.equal(inferChain(MINT),'solana');assert.throws(()=>inferChain(ADDRESS,'wrong'));
  assert.equal((await callTool('scan_token_safety',{address:ADDRESS},{rpc:baseScanRpc()})).chain,'base');
  const dir=await testTemp('cabal-infer-');t.after(()=>rm(dir,{recursive:true,force:true}));const licensePath=join(dir,'license.json');await saveLicense({chain:'base',txHash:HASH},{licensePath,rpc:basePayment()});
  assert.equal((await callTool('detect_block0_bundler',{address:ADDRESS},{licensePath,rpc:baseScanRpc()})).chain,'base');
  const child=spawnSync(process.execPath,['--import=./test/cli-rpc-preload.js','bin/cabal-radar.js','scan',ADDRESS,'--json'],{encoding:'utf8',env:{...process.env,BASE_RPC_URL:'https://rpc.example.test'}});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,'');assert.equal(JSON.parse(child.stdout).chain,'base');
});
test('page retains copy contract, has live checkout and ArrowLeft moves backwards',async()=>{
  const html=await readFile(new URL('../docs/index.html',import.meta.url),'utf8');
  for(const id of ['live-scanner','scan-form','token-input','live-result','browser-pro','receipt-form','activation-command'])assert.ok(html.includes(`id="${id}"`));
  assert.equal([...html.matchAll(/data-copy-target=/g)].length,3);assert.equal([...html.matchAll(/data-sample=/g)].length,3);assert.ok(!html.includes('Receipts are public and reusable'));
  const ids=new Map();const element=id=>{if(!ids.has(id))ids.set(id,{id,dataset:{},handlers:{},setAttribute(){},focus(){},addEventListener(k,f){this.handlers[k]=f;}});return ids.get(id);};
  // Three synthetic tabs distinguish left from right (two tabs alone cannot).
  const tabs=['cli','mcp','third'].map(name=>Object.assign(element(name),{dataset:{tab:name}}));
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{document:{getElementById:element,querySelectorAll:q=>q==='[data-tab]'?tabs:[]},setTimeout,clearTimeout});
  tabs[1].handlers.keydown({key:'ArrowLeft',preventDefault(){}});assert.equal(element('cli-panel').hidden,false);assert.equal(element('third-panel').hidden,true);
});
test('browser bundle is synchronized with portable production modules',async()=>{
  assert.equal(await readFile(new URL('../docs/scanner-core.js',import.meta.url),'utf8'),await browserSource());
});
test('unlisted pool PDAs, adjacent organic buys, Base pair sells, auditorElgamalPubkey and opt-out flags',async t=>{
  assert.ok(codes(await scanSolanaTokenBasic(MINT,{rpc:solScanRpc({info:{extensions:[{extension:'confidentialTransferMint',state:{auditorElgamalPubkey:WALLET}}]}})})).includes('CONFIDENTIAL_TRANSFER_CONTROL'));
  const pool='7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const organic=[
    solTx({slot:100,transaction:{signatures:['s1'],message:{accountKeys:[{pubkey:WALLET,signer:true}],instructions:[]}},meta:{preTokenBalances:[tokenBalance(pool,1000)],postTokenBalances:[tokenBalance(pool,900),tokenBalance(WALLET,100)]}}),
    solTx({slot:102,transaction:{signatures:['s2'],message:{accountKeys:[{pubkey:OTHER,signer:true}],instructions:[]}},meta:{preTokenBalances:[tokenBalance(pool,900)],postTokenBalances:[tokenBalance(pool,800),tokenBalance(OTHER,100)]}})
  ];
  const rSol=await detectSolanaBlock0Bundler(MINT,{basic:{holders:[],supply:'1000'},rpc:solScanRpc({history:[{signature:'s1',slot:100,err:null},{signature:'s2',slot:102,err:null}],transactions:{s1:organic[0],s2:organic[1]}})});
  assert.equal(rSol.bundlerVerdict,'INSUFFICIENT_EVIDENCE');assert.deepEqual(rSol.coordinatedWallets,[]);
  const fullPage=Array.from({length:100},(_,i)=>({signature:`p${i}`,slot:100+i,err:null}));
  const notReached=await detectSolanaBlock0Bundler(MINT,{maxPages:1,maxTransactions:1,basic:{holders:[],supply:'1000'},rpc:solScanRpc({history:fullPage,transactions:{p0:organic[0]}})});
  assert.equal(notReached.bundlerVerdict,'LAUNCH_NOT_REACHED');
  const pair=`0x${'ab'.repeat(20)}`,u1=`0x${'11'.repeat(20)}`,u2=`0x${'22'.repeat(20)}`,u3=`0x${'33'.repeat(20)}`;
  const pairLogs=[[5000,pair,u1,1],[5000,u2,pair,2],[5001,pair,u3,3]].map(([b,f,to,i])=>({address:ADDRESS,topics:[C.TRANSFER_TOPIC,topic(f),topic(to)],data:`0x${word(1000)}`,blockNumber:`0x${b.toString(16)}`,transactionHash:`0x${word(i)}`,logIndex:'0x0'}));
  const rBase=await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{fromBlock:4000,rpc:baseScanRpc({latest:'0x1388',logs:pairLogs})});
  assert.equal(rBase.bundlerVerdict,'INSUFFICIENT_EVIDENCE');assert.ok(!rBase.coordinatedWallets.includes(pair));
  let hits=[];t.mock.method(globalThis,'fetch',async url=>{hits.push(new URL(url).host);return hits.length<=2?new Response('',{status:429,headers:{'retry-after':'0.01'}}):json({jsonrpc:'2.0',id:3,result:7});});
  assert.equal(await rpcClient('solana',{baseDelayMs:10})('getHealth'),7);assert.deepEqual(hits,['api.mainnet-beta.solana.com','solana-rpc.publicnode.com','solana-rpc.publicnode.com']);
  const dir=await testTemp('cabal-batch-infer-');t.after(()=>rm(dir,{recursive:true,force:true}));const licensePath=join(dir,'license.json');await saveLicense({chain:'base',txHash:HASH},{licensePath,rpc:basePayment()});
  const batch=await callTool('batch_audit_watchlist',{tokens:[{address:ADDRESS}]},{licensePath,rpc:baseScanRpc()});assert.equal(batch.results[0].chain,'base');
});
test('adversarial bundler chaining, dev multi-send, Base post-buy forwarding, high buy tax, PDA pool exclusion and proxy unresolved',async()=>{
  const pool='7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const w4='4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T',w5='5Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
  const list=[WALLET,OTHER,THIRD,w4,w5];
  const chainTxs=list.map((w,i)=>solTx({slot:100+i*2,transaction:{signatures:[`c${i}`],message:{accountKeys:[{pubkey:w,signer:true}],instructions:[]}},meta:{preTokenBalances:[tokenBalance(pool,1000-i*100)],postTokenBalances:[tokenBalance(pool,900-i*100),tokenBalance(w,100)]}}));
  const rChain=await detectSolanaBlock0Bundler(MINT,{basic:{holders:[],supply:'1000'},rpc:solScanRpc({history:list.map((_,i)=>({signature:`c${i}`,slot:100+i*2,err:null})),transactions:Object.fromEntries(chainTxs.map((tx,i)=>[`c${i}`,tx]))})});
  assert.equal(rChain.bundlerVerdict,'INSUFFICIENT_EVIDENCE');assert.deepEqual(rChain.coordinatedWallets,[]);
  const jitoTip=solTx({slot:101,transaction:{signatures:['j2'],message:{accountKeys:[{pubkey:OTHER,signer:true}],instructions:[{program:'system',parsed:{type:'transfer',info:{source:OTHER,destination:C.JITO_TIP_ACCOUNTS[0],lamports:10000}}}]}},meta:{preTokenBalances:[tokenBalance(pool,900)],postTokenBalances:[tokenBalance(pool,800),tokenBalance(OTHER,100)]}});
  const rJito=await detectSolanaBlock0Bundler(MINT,{basic:{holders:[],supply:'1000'},rpc:solScanRpc({history:[{signature:'c0',slot:100,err:null},{signature:'j2',slot:101,err:null}],transactions:{c0:chainTxs[0],j2:jitoTip}})});
  assert.equal(rJito.bundlerVerdict,'INSUFFICIENT_EVIDENCE');assert.deepEqual(rJito.coordinatedWallets,[]);
  const devDist=solTx({slot:50,transaction:{signatures:['dev'],message:{accountKeys:[{pubkey:w4,signer:true}],instructions:[]}},meta:{preTokenBalances:[tokenBalance(w4,1000)],postTokenBalances:[tokenBalance(w4,100),tokenBalance(WALLET,300),tokenBalance(OTHER,300),tokenBalance(THIRD,300)]}});
  const rDev=await detectSolanaBlock0Bundler(MINT,{basic:{holders:[],supply:'1000'},rpc:solScanRpc({history:[{signature:'dev',slot:50,err:null}],transactions:{dev:devDist}})});
  assert.equal(rDev.bundlerVerdict,'COORDINATION_SUSPECTED');assert.equal(rDev.coordinatedWallets.length,3);
  const pdaVault='8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',pdaOwner='9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const baseRpc=solScanRpc({largest:[{address:pdaVault,amount:'600'},{address:OTHER,amount:'100'}]});
  const rPda=await scanSolanaTokenBasic(MINT,{rpc:async(m,p)=>{
    if(m==='getMultipleAccounts')return {value:p[0].map(a=>a===pdaVault?{data:{parsed:{info:{owner:pdaOwner}}}}:a===OTHER?{data:{parsed:{info:{owner:WALLET}}}}:a===pdaOwner?{owner:C.KNOWN_SOLANA_POOLS_AND_PROGRAMS[0]}:{owner:'11111111111111111111111111111111'})};
    return baseRpc(m,p);
  }});
  assert.equal(rPda.holders.find(h=>h.address===pdaVault).isPool,true);assert.equal(rPda.holders.find(h=>h.address===OTHER).isPool,false);assert.ok(!codes(rPda).includes('TOP10_CONCENTRATION'));
  const pair=`0x${'ab'.repeat(20)}`,b1=`0x${'11'.repeat(20)}`,b2=`0x${'22'.repeat(20)}`,b3=`0x${'33'.repeat(20)}`,b4=`0x${'44'.repeat(20)}`;
  const cLogs=[[100,pair,b1,1],[100,pair,b2,2],[100,pair,b3,3],[150,b1,pair,4],[160,b2,b4,5]].map(([b,f,to,i])=>({address:ADDRESS,topics:[C.TRANSFER_TOPIC,topic(f),topic(to)],data:`0x${word(100)}`,blockNumber:`0x${b.toString(16)}`,transactionHash:`0x${word(i)}`,logIndex:'0x0'}));
  const rBaseC=await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{fromBlock:100,rpc:baseScanRpc({latest:'0xc8',logs:cLogs})});
  assert.equal(rBaseC.bundlerVerdict,'EARLY_CONCENTRATION_OBSERVED');assert.equal(rBaseC.earlyWalletCount,3);
  const rBuyTax=await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{rpc:baseScanRpc(),enrichmentFetch:async()=>json({simulationResult:{buyTax:90,sellTax:0},honeypotResult:{isHoneypot:false}})});
  assert.equal(rBuyTax.honeypotVerdict,'REVIEW_REQUIRED');
  const impl=`0x${'34'.repeat(20)}`,eip1167=`0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  const fProxy=baseScanRpc({code:eip1167});
  const rProxy=await scanBaseTokenBasic(ADDRESS,{rpc:async(m,p)=>m==='eth_getCode'&&p[0]===impl?Promise.reject(new RpcError('429',429)):fProxy(m,p)});
  assert.ok(rProxy.unavailable.includes('implementationBytecode'));assert.ok(codes(rProxy).includes('PROXY_UNRESOLVED'));assert.equal(rProxy.bytecode.implementation,undefined);
});

