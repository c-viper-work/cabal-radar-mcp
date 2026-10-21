import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scanLive, verifyReceipt, initScanner } from '../docs/live-scanner.js';
import * as C from '../src/constants.js';
import { ADDRESS, MINT, OTHER, WALLET, HASH, SIG, baseScanRpc, basePayment, solTx, usdcLog } from './fixtures.js';
const json = data => new Response(JSON.stringify(data));
test('browser Solana telemetry excludes pools, surfaces extensions and preserves unknown tax', async()=>{
  const report=await scanLive(MINT,{fetch:async url=>{
    if(url.includes('dexscreener'))return json({pairs:[{chainId:'solana',baseToken:{address:MINT,symbol:'TEST',name:'Synthetic'},liquidity:{usd:10000},volume:{h24:20000},fdv:50000,pairCreatedAt:1000,dexId:'raydium'}]});
    if(url.includes('rugcheck'))return json({token:{supply:'1000',mintAuthority:null,freezeAuthority:null,extensions:[{extension:'scaledUiAmountConfig',state:{authority:WALLET}}]},topHolders:[{address:OTHER,owner:C.KNOWN_SOLANA_POOLS_AND_PROGRAMS[3],amount:'800'},{address:WALLET,owner:WALLET,amount:'100',insider:true}]});
    return json({result:{[MINT]:{}}});
  }});
  assert.equal(report.symbol,'TEST');assert.equal(report.liquidity,10000);assert.equal(report.concentration,10);assert.equal(report.buyTax,null);assert.equal(report.mintAuthority,'Revoked');assert.equal(report.holders.filter(h=>h.isPool).length,1);assert.ok(report.flags.some(f=>f.code==='BALANCE_MANIPULATION_EXTENSION'));assert.equal(report.holders.find(h=>!h.isPool).insider,true);
});
test('browser Base scans merge metadata, simulation and malicious controls',async()=>{
  const fixture=baseScanRpc();
  const report=await scanLive(ADDRESS,{fetch:async(url,o)=>{
    if(o.body){const q=JSON.parse(o.body);return json({jsonrpc:'2.0',id:q.id,result:await fixture(q.method,q.params)});}
    if(url.includes('honeypot'))return json({simulationResult:{buyTax:1,sellTax:99},honeypotResult:{isHoneypot:true}});
    if(url.includes('goplus'))return json({result:{[ADDRESS]:{is_blacklisted:'1',holders:[{address:C.EVM_RECIPIENT,percent:'0.2'},{address:C.KNOWN_BASE_ROUTERS_AND_POOLS[0],percent:'0.5'}]}}});
    return json({pairs:[]});
  }});
  assert.equal(report.chain,'base');assert.equal(report.symbol,'TEST');assert.equal(report.sellTax,99);assert.equal(report.riskLevel,'CRITICAL');assert.equal(report.concentration,20);assert.ok(report.flags.some(f=>f.code==='BLACKLIST'));
});
test('browser total provider failure never becomes a safe score or zero concentration',async()=>{
  const report=await scanLive(MINT,{fetch:async()=>{throw new Error('CORS');}});
  assert.equal(report.safetyScore,null);assert.equal(report.riskLevel,'UNKNOWN');assert.equal(report.concentration,null);assert.equal(report.confidence,'LOW');assert.equal(report.errors.length,3);
});
test('browser receipt verifier uses official shared rules for both chains',async()=>{
  assert.equal((await verifyReceipt(HASH,{rpc:basePayment({tx:{to:ADDRESS,value:'0x0'},receipt:{logs:[usdcLog(7000000n),usdcLog(8000000n)]}})})).verified,true);
  assert.equal((await verifyReceipt(SIG,{rpc:async m=>m==='getGenesisHash'?C.SOLANA_GENESIS:solTx()})).chain,'solana');
  await assert.rejects(verifyReceipt(HASH,{rpc:basePayment({tx:{to:ADDRESS}})}));
});
function browser(t, stored=null) {
  const elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{id,textContent:'',value:'',dataset:{},hidden:false,disabled:false,handlers:{},children:[],addEventListener(name,fn){this.handlers[name]=fn;},append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},focus(){},scrollIntoView(){}});return elements.get(id);};
  const pay=['eth','usdc'].map(asset=>Object.assign(el(asset),{dataset:{pay:asset}}));
  const groups={'[data-pay]':pay,'[data-sample]':[],'[data-export]':[]};
  const document={getElementById:el,querySelectorAll:q=>groups[q]||[],createElement:tag=>({tag,children:[],textContent:'',append(...items){this.children.push(...items);}})};
  const storage=new Map(stored?[['cabal-radar-browser-receipt-v1',JSON.stringify(stored)]]:[]);
  for(const [key,value] of Object.entries({document,window:{},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}})){
    const prior=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    t.after(()=>{if(prior)Object.defineProperty(globalThis,key,prior);else delete globalThis[key];});
  }
  return {el,pay,storage};
}
for(const asset of ['eth','usdc'])test(`browser wallet ${asset} submits exact Base transfer and verifies receipt`,async t=>{
  const {el,pay,storage}=browser(t);const calls=[];
  window.ethereum={request:async q=>{calls.push(q);return q.method==='eth_chainId'?'0x2105':q.method==='eth_requestAccounts'?[ADDRESS]:q.method==='eth_sendTransaction'?HASH:null;}};
  const fixture=asset==='eth'?basePayment():basePayment({tx:{to:ADDRESS,value:'0x0'},receipt:{logs:[usdcLog()]}});
  t.mock.method(globalThis,'fetch',async(_,o)=>{const q=JSON.parse(o.body);return json({jsonrpc:'2.0',id:q.id,result:await fixture(q.method,q.params)});});
  initScanner();await pay.find(p=>p.dataset.pay===asset).handlers.click();
  const sends=calls.filter(q=>q.method==='eth_sendTransaction');assert.equal(sends.length,1);
  const tx=sends[0].params[0];assert.equal(tx.from,ADDRESS);
  if(asset==='eth'){assert.equal(tx.to,C.EVM_RECIPIENT);assert.equal(BigInt(tx.value),C.MIN_ETH);assert.equal(tx.data,undefined);}
  else {assert.equal(tx.to,C.BASE_USDC);assert.equal(tx.value,'0x0');assert.equal(tx.data,`0xa9059cbb${C.EVM_RECIPIENT.slice(2).toLowerCase().padStart(64,'0')}${C.MIN_USDC.toString(16).padStart(64,'0')}`);}
  assert.equal(el('checkout').hidden,true);assert.match(el('activation-command').textContent,new RegExp(`cabal-radar activate --tx ${HASH} --chain base`));assert.equal(JSON.parse(storage.get('cabal-radar-browser-receipt-v1')).txHash,HASH);
});
test('browser wrong wallet chain cannot submit payment',async t=>{
  const {pay,el}=browser(t);const calls=[];window.ethereum={request:async q=>{calls.push(q.method);return q.method==='eth_chainId'?'0x1':null;}};
  initScanner();await pay[0].handlers.click();assert.ok(!calls.includes('eth_sendTransaction'));assert.match(el('checkout-status').textContent,/Base mainnet/);
});
test('stored active flag cannot bypass receipt verification',async t=>{
  const {el}=browser(t,{active:true,txHash:HASH});let reads=0;
  t.mock.method(globalThis,'fetch',async()=>{reads++;return new Response('',{status:403});});
  initScanner();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,2);assert.notEqual(el('checkout').hidden,true);assert.match(el('checkout-status').textContent,/could not be reverified/);
});
test('social card PNG is 1200×630 and page metadata points to existing assets',async()=>{
  const png=await readFile(new URL('../docs/og-card.png',import.meta.url));assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),1200);assert.equal(png.readUInt32BE(20),630);
  const html=await readFile(new URL('../docs/index.html',import.meta.url),'utf8');assert.match(html,/og:image" content="https:\/\/c-viper-work.github.io\/cabal-radar-mcp\/og-card.png/);assert.match(html,/twitter:card" content="summary_large_image/);
});
test('browser retains provider percentages when raw JSON token supply is precision-unsafe',async()=>{
  const report=await scanLive(MINT,{fetch:async url=>url.includes('rugcheck')?json({token:{supply:1e20},topHolders:[{address:OTHER,owner:WALLET,amount:1e19,pct:10}]}):json({})});
  assert.equal(report.concentration,10);assert.equal(report.holders[0].amount,null);
});
