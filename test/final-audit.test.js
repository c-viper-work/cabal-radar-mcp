import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { solanaHistory, traceSolanaFundingClusters, detectSolanaBlock0Bundler } from '../src/solana-scanner.js';
import { createMcpHandler } from '../src/mcp-server.js';
import { saveLicense, checkProStatus } from '../src/license.js';
import { testTemp } from './temp.js';
import { SOLANA_GENESIS } from '../src/constants.js';
import { MINT, WALLET, OTHER, THIRD, ADDRESS, HASH, solScanRpc, solTx, tokenBalance, baseScanRpc, basePayment } from './fixtures.js';
const init = {jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1'},capabilities:{}}};
const transfer = (holder, source) => ({program:'system',parsed:{type:'transfer',info:{destination:holder,source,lamports:1000000}}});
test('funding rejects wrong genesis before any history and checks mainnet exactly once', async () => {
  const calls=[];
  await assert.rejects(traceSolanaFundingClusters([WALLET,OTHER],{rpc:async m=>{calls.push(m);return 'wrong';}}),/mainnet/);
  assert.deepEqual(calls,['getGenesisHash']);
  calls.length=0;
  await traceSolanaFundingClusters([WALLET,OTHER],{rpc:async m=>{calls.push(m);return m==='getGenesisHash'?SOLANA_GENESIS:[];}});
  assert.equal(calls.filter(m=>m==='getGenesisHash').length,1);
});
test('same-slot histories reverse RPC indices and CPI executes before the next top-level instruction', async () => {
  const rpc=solScanRpc({history:p=>[{signature:p[0]+'new',slot:10,err:null},{signature:p[0]+'old',slot:10,err:null}],transactions:Object.fromEntries([WALLET,OTHER].flatMap(holder=>[
    [holder+'new',solTx({transaction:{message:{instructions:[transfer(holder,THIRD)]}}})],
    [holder+'old',solTx({transaction:{message:{instructions:[{program:'wrapper'},transfer(holder,THIRD)]}},meta:{innerInstructions:[{index:1,instructions:[transfer(holder,THIRD)]},{index:0,instructions:[transfer(holder,MINT),transfer(holder,THIRD)]}]}})]
  ]))});
  const result=await traceSolanaFundingClusters([WALLET,OTHER],{rpc});
  assert.deepEqual(result.motherWallets,[MINT]);
  const h=await solanaHistory(WALLET,{rpc,maxTransactions:1});
  assert.equal(h.transactions[0].transaction.message.instructions[0].program,'wrapper');
});
test('holder-only SPL acquisitions are included, capped and deduplicated before transaction RPC',async()=>{
  const addresses=[WALLET,OTHER,THIRD,...Array.from({length:3},(_,i)=>'account'+i)];
  const queried=[],fetched=[];
  const fixture=solScanRpc({history:p=>{queried.push(p);return p[0]===MINT?[{signature:'shared',slot:12,err:null}]:Array.from({length:12},(_,i)=>({signature:i===0?'shared':'holder'+i,slot:i===0?0:12-i,err:null}));},transactions:Object.fromEntries(['shared',...Array.from({length:11},(_,i)=>'holder'+(i+1))].map((sig,i)=>[sig,solTx({slot:10,transaction:{message:{accountKeys:[OTHER],instructions:[{program:'spl-token',parsed:{type:'transfer',info:{source:OTHER,destination:THIRD,amount:'1'}}}]}},meta:{postTokenBalances:[tokenBalance(i?OTHER:WALLET,1)]}})]))});
  const result=await detectSolanaBlock0Bundler(MINT,{basic:{holders:addresses.map(address=>({address,amount:'1'})),supply:'100'},rpc:async(m,p)=>{if(m==='getTransaction')fetched.push(p[0]);return fixture(m,p);}});
  assert.deepEqual(queried.map(p=>p[0]),[MINT,...addresses.slice(0,5)]);
  assert.equal(result.coverage.holderAccountsSampled,5);
  assert.equal(fetched.length,10);assert.equal(new Set(fetched).size,10);
  assert.equal(result.bundleClusterCount,1);assert.ok(result.coordinatedWallets.includes(OTHER));
});
test('initialize requires a nonempty string client version',async()=>{
  for(const version of [undefined,null,0,{},[],'']) {
    const h=createMcpHandler();
    assert.equal((await h({...init,params:{...init.params,clientInfo:{name:'test',version}}})).error.code,-32602);
    assert.equal((await h({jsonrpc:'2.0',id:1,method:'tools/list'})).error.code,-32002);
  }
  assert.ok((await createMcpHandler()(init)).result);
});
test('MCP bounds running tools and queue, cancels queued IDs, and cleans shared abort listeners',async()=>{
  const outer=new AbortController(), releases=[];let started=0,live=0,peak=0;
  const fixture=baseScanRpc();
  const h=createMcpHandler({signal:outer.signal,rpc:async(m,p)=>{
    if(m==='eth_chainId') {started++;live++;peak=Math.max(peak,live);await new Promise(resolve=>releases.push(()=>{live--;resolve();}));}
    return fixture(m,p);
  }});
  await h(init);
  const request=id=>({jsonrpc:'2.0',id,method:'tools/call',params:{name:'scan_token_safety',arguments:{chain:'base',address:ADDRESS}}});
  const pending=Array.from({length:68},(_,i)=>h(request(i+1)));
  assert.equal(started,4);assert.equal(getEventListeners(outer.signal,'abort').length,4);
  assert.deepEqual((await h(request(69))).error,{code:-32000,message:'Server busy'});
  assert.ok((await h({...init,id:100})).result);
  for(const method of ['ping','tools/list']) assert.ok((await h({jsonrpc:'2.0',id:100,method})).result);
  assert.equal(await h({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:5}}),null);
  assert.equal(await pending[4],null);
  pending.push(h(request(69)));
  assert.equal((await h(request(6))).error.code,-32600);
  while(started<68 || live) {
    releases.splice(0).forEach(release=>release());
    await new Promise(resolve=>setImmediate(resolve));
  }
  const results=await Promise.all(pending);
  assert.equal(results.filter(Boolean).length,68);assert.equal(peak,4);
  assert.equal(getEventListeners(outer.signal,'abort').length,0);
});
test('both temp roots denied uses virtual files with real license integrity validation',async t=>{
  const attempts=[];
  const dir=await testTemp('readonly-', {create:async path=>{attempts.push(path);throw Object.assign(new Error('readonly'),{code:attempts.length===1?'EPERM':'EROFS'});}});
  t.after(()=>rm(dir,{recursive:true,force:true}));assert.equal(attempts.length,2);
  const options={licensePath:join(dir,'license.json'),rpc:basePayment()};
  assert.equal((await checkProStatus(options)).active,false);
  await saveLicense({chain:'base',txHash:HASH},options);
  assert.equal((await checkProStatus(options)).active,true);
  const record=JSON.parse(await readFile(options.licensePath));record.txHash='tampered';
  await writeFile(options.licensePath,JSON.stringify(record));
  assert.equal((await checkProStatus(options)).active,false);
  await assert.rejects(testTemp('full-',{create:async()=>{throw Object.assign(new Error('full'),{code:'ENOSPC'});}}),/full/);
});
