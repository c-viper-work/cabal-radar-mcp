import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { rm } from 'node:fs/promises';
import { scanSolanaTokenBasic, detectSolanaBlock0Bundler, traceSolanaFundingClusters } from '../src/solana-scanner.js';
import { scanBaseTokenBasic, detectBaseEarlyBundlerAndHoneypot, inspectBytecode } from '../src/base-scanner.js';
import { rpcClient, RpcError } from '../src/rpc.js';
import { createMcpHandler, startMcpServer } from '../src/mcp-server.js';
import { testTemp } from './temp.js';
import * as C from '../src/constants.js';
import { MINT, WALLET, OTHER, THIRD, ADDRESS, HASH, word, topic, solTx, solScanRpc, baseScanRpc, tokenBalance } from './fixtures.js';
const codes = r => r.flags.map(f => f.code);
async function extension(extension, state) { return scanSolanaTokenBasic(MINT, { rpc: solScanRpc({ info: { extensions: [{ extension, ...(state === undefined ? {} : {state}) }] } }) }); }
for (const field of ['accountState', 'state']) test(`1 defaultAccountState ${field} case-insensitive`, async () => {
  assert.ok(codes(await extension('defaultAccountState', {[field]: 'FrOzEn'})).includes('DEFAULT_FROZEN'));
  assert.ok(!codes(await extension('defaultAccountState', {[field]: 'initialized'})).includes('DEFAULT_FROZEN'));
});
test('2 non-transferable and mutable transfer fees', async () => {
  assert.equal((await extension('nonTransferable')).flags[0].penalty, 35);
  for (const bps of [0,999,1000]) for (const authority of [null,WALLET]) {
    const r = await extension('transferFeeConfig', {transferFeeConfigAuthority:authority,newerTransferFee:{transferFeeBasisPoints:bps}});
    assert.equal(codes(r).includes('MUTABLE_TRANSFER_FEE'), bps < 1000 && authority !== null);
    assert.equal(codes(r).includes('HIGH_TRANSFER_FEE'), bps >= 1000);
  }
});
for (const name of ['pausable','pausableConfig']) test(`2 ${name} paused and authority states`, async () => {
  for (const paused of [false,true]) for (const authority of [null,WALLET]) {
    const r = await extension(name,{paused,authority});
    assert.equal(codes(r).includes('PAUSABLE'),paused || authority !== null);
    if (r.flags.length) assert.equal(r.flags[0].penalty,paused ? 35 : 20);
  }
});
test('3 fake metadata cannot hide executable opcodes, including PUSH-contained terminal bytes', () => {
  const metadata = 'a164736f6c63435bf4ff', suffix = metadata + (metadata.length / 2).toString(16).padStart(4,'0');
  for (const prefix of ['5b','60fe','00','f3','fd','fe','ff']) {
    assert.ok(codes(inspectBytecode(`0x${prefix}${suffix}`)).includes('DELEGATECALL'));
  }
  assert.ok(codes(inspectBytecode(`0x5b${metadata}ffff`)).includes('SELFDESTRUCT'));
  assert.deepEqual(codes(inspectBytecode('0x62fff400')),[]);
});
test('4 revoked delegate and hook controls are excluded', async () => {
  for (const state of [{delegate:null},{}]) assert.ok(!codes(await extension('permanentDelegate',state)).includes('permanentDelegate'));
  for (const state of [undefined,{delegate:WALLET}]) assert.ok(codes(await extension('permanentDelegate',state)).includes('permanentDelegate'));
  for (const state of [undefined,{}, {programId:null,authority:''}]) assert.ok(!codes(await extension('transferHook',state)).includes('transferHook'));
  for (const state of [{programId:WALLET},{authority:WALLET}]) assert.ok(codes(await extension('transferHook',state)).includes('transferHook'));
});
function acquisitionRpc() {
  return solScanRpc({history:[10,12,13].map(slot=>({signature:String(slot),slot,err:null})),transactions:Object.fromEntries([10,12,13].map((slot,i)=>[String(slot),solTx({slot,meta:{postTokenBalances:[tokenBalance([WALLET,WALLET,OTHER][i],100)]}})]))});
}
test('5 connected acquisition window cannot be split by an earlier event', async () => {
  const r = await detectSolanaBlock0Bundler(MINT,{rpc:acquisitionRpc()});
  assert.equal(r.bundleClusterCount,1); assert.equal(r.clusters[0].lastSlot,13); assert.ok(r.coordinatedWallets.includes(OTHER));
});
const funding = (holder,source,lamports) => ({program:'system',parsed:{type:'transfer',info:{source,destination:holder,lamports}}});
test('5/9 timing windows connect, dust cannot replace real funders, configurable threshold', async () => {
  const holders=[WALLET,OTHER,THIRD], sources=[MINT,THIRD,MINT];
  const rpc=solScanRpc({history:p=>[{signature:p[0],slot:10,err:null}],transactions:Object.fromEntries(holders.map((holder,i)=>[holder,solTx({blockTime:[0,60,61][i],transaction:{message:{instructions:[funding(holder,ADDRESS,999999),funding(holder,sources[i],1000000)]}}})]))});
  const r=await traceSolanaFundingClusters(holders,{rpc});
  assert.equal(r.coverage.ignoredDustTransfers,3);
  assert.equal(r.clusters.find(c=>c.type==='TIMING_ONLY').holders.length,3);
  assert.ok(!r.motherWallets.includes(ADDRESS));
  const lowered=await traceSolanaFundingClusters(holders,{rpc,minFundingLamports:999999});
  assert.deepEqual(lowered.motherWallets,[ADDRESS]); assert.equal(lowered.coverage.ignoredDustTransfers,0);
});
function log(block,from,to,amount,index) { return {address:ADDRESS,topics:[C.TRANSFER_TOPIC,`0x${word(from)}`,`0x${word(to)}`],data:`0x${word(amount)}`,blockNumber:`0x${block.toString(16)}`,transactionHash:HASH,logIndex:`0x${index}`}; }
test('6/7 mint and zero transfers do not anchor or dilute early concentration', async () => {
  const logs=[log(1,0,1,1000,0),log(2,1,2,0,1),log(10,1,3,100,2),log(11,1,4,100,3),log(11,1,5,0,4),log(12,1,6,200,5)];
  const r=await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{rpc:baseScanRpc({logs})});
  assert.equal(r.coverage.firstObservedBlock,'1'); assert.equal(r.coverage.firstTransferBlock,'10'); assert.equal(r.earlyWalletCount,2); assert.equal(r.largestEarlyRecipientPct,50);
  const empty=await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{rpc:baseScanRpc({logs:logs.slice(0,2)})});
  assert.equal(empty.earlyWalletCount,0); assert.equal(empty.coverage.firstTransferBlock,null);
});
const simulation={simulationFrom:ADDRESS,simulationTo:C.EVM_RECIPIENT,simulationAmount:'1'};
const simulationData=`0xa9059cbb${C.EVM_RECIPIENT.slice(2).toLowerCase().padStart(64,'0')}${word(1)}`;
for (const [result,status] of [[`0x${word(0)}`,'RETURNED_FALSE'],['0x1234','NONSTANDARD_RETURN'],['0x','CALL_SUCCEEDED'],[`0x${word(1)}`,'CALL_SUCCEEDED']]) test(`8 transfer simulation ${status}: ${result.slice(0,10)}`,async()=>{
  const r=await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{...simulation,rpc:baseScanRpc({calls:{[simulationData]:result}})});
  assert.equal(r.transferSimulation.status,status); assert.equal(r.honeypotVerdict,status==='CALL_SUCCEEDED'?'UNKNOWN':'REVIEW_REQUIRED');
});
test('10 scanners reject wrong networks even if skipNetworkCheck is supplied',async()=>{
  for (const [scan,address,fixture,method] of [[scanBaseTokenBasic,ADDRESS,baseScanRpc(),'eth_chainId'],[scanSolanaTokenBasic,MINT,solScanRpc(),'getGenesisHash']]) {
    let calls=0;
    await assert.rejects(scan(address,{skipNetworkCheck:true,rpc:async(m,p)=>{calls++;return m===method?'wrong':fixture(m,p);}}),/mainnet/);
    assert.equal(calls,1);
  }
});
test('11 unresolved holder supply is explicit and all unresolved exposure is null',async()=>{
  const rpc=acquisitionRpc();
  for (const missing of [null,{data:{parsed:{info:{}}}}]) {
    const r=await detectSolanaBlock0Bundler(MINT,{rpc:async(m,p)=>m==='getAccountInfo'&&p[0]!==MINT?{value:missing}:rpc(m,p)});
    assert.equal(r.coverage.unresolvedHolderAccounts,1); assert.equal(r.coverage.unresolvedSupplyPct,10); assert.equal(r.bundledSupplyPct,null);
  }
});
function errorRpc(code,message) {return rpcClient('base',{fetch:async(_,o)=>({ok:true,json:async()=>({jsonrpc:'2.0',id:JSON.parse(o.body).id,error:{code,message}})})});}
test('12 RPC distinguishes actual revert from generic node failures in metadata and simulation',async()=>{
  for (const [code,message,isRevert] of [[3,'failure',true],[-32000,'execution reverted',true],[-32000,'VM execution error',true],[-32000,'revert',true],[-32000,'missing trie node',false]]) {
    let err; try {await errorRpc(code,message)('eth_call');} catch(e) {err=e;}
    assert.equal(err.isRevert,isRevert);
    const fixture=baseScanRpc();
    const rpc=async(m,p)=>m==='eth_call'?Promise.reject(err):fixture(m,p);
    if (isRevert) assert.ok(codes(await scanBaseTokenBasic(ADDRESS,{rpc})).includes('INCOMPLETE_METADATA'));
    else await assert.rejects(scanBaseTokenBasic(ADDRESS,{rpc}),e=>e===err);
    const opts={...simulation,rpc:baseScanRpc({calls:{[simulationData]:err}})};
    if (isRevert) assert.equal((await detectBaseEarlyBundlerAndHoneypot(ADDRESS,opts)).transferSimulation.status,'REVERTED');
    else await assert.rejects(detectBaseEarlyBundlerAndHoneypot(ADDRESS,opts),e=>e===err);
  }
});
test('14 non-integer RPC error codes cannot expose secrets',async()=>{
  for (const code of ['https://secret:password@example.com',{},1.5,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(errorRpc(code,'secret')('eth_call'),e=>e.code==='unknown'&&e.message==='RPC eth_call failed (unknown)');
});
test('15 exact thresholds flag fractions hidden by display rounding',async()=>{
  const r=await scanSolanaTokenBasic(MINT,{rpc:solScanRpc({info:{supply:'100000'},largest:[{address:OTHER,amount:'20001'},{address:THIRD,amount:'15000'},{address:WALLET,amount:'15000'}]})});
  assert.equal(r.largestHolderPct,20); assert.equal(r.top10HolderPct,50); assert.ok(codes(r).includes('LARGE_ACCOUNT')); assert.ok(codes(r).includes('TOP10_CONCENTRATION'));
  const boundary=await scanSolanaTokenBasic(MINT,{rpc:solScanRpc({info:{supply:'100000'},largest:[{address:OTHER,amount:'20000'},{address:THIRD,amount:'15000'},{address:WALLET,amount:'15000'}]})});
  assert.deepEqual(codes(boundary),[]);
});
test('Solana holder RPC restrictions degrade gracefully', async () => {
  const fixture = solScanRpc();
  for (const err of [
    new RpcError('RPC getTokenLargestAccounts: HTTP 429'),
    new RpcError('RPC getTokenLargestAccounts: HTTP 403'),
    ...[-32000, -32005, -32012, 429].map(code => new RpcError('RPC getTokenLargestAccounts failed', code))
  ]) {
    const rpc = async (method, params) => {
      if (method === 'getTokenLargestAccounts') throw err;
      return fixture(method, params);
    };
    const result = await scanSolanaTokenBasic(MINT, { rpc });
    assert.deepEqual(result.holders, []);
    assert.equal(result.top10HolderPct, null);
    assert.equal(result.largestHolderPct, null);
    assert.deepEqual(result.flags, [{ code: 'HOLDER_DATA_UNAVAILABLE', penalty: 15, detail: 'Largest-account query rate-limited or restricted by RPC; holder concentration not evaluated' }]);
  }
});
test('Solana holder query still rejects malformed responses and unrelated failures', async () => {
  const fixture = solScanRpc();
  for (const value of [null, undefined, {}]) {
    await assert.rejects(scanSolanaTokenBasic(MINT, {
      rpc: async (method, params) => method === 'getTokenLargestAccounts' ? { value } : fixture(method, params)
    }), /Missing largest token accounts/);
  }
  for (const err of [new Error('RPC getTokenLargestAccounts: HTTP 429'), new RpcError('RPC getTokenLargestAccounts: HTTP 500'), new RpcError('RPC failure', -32603)]) {
    await assert.rejects(scanSolanaTokenBasic(MINT, {
      rpc: async (method, params) => {
        if (method === 'getTokenLargestAccounts') throw err;
        return fixture(method, params);
      }
    }), error => error === err);
  }
});
test('16 deep scans reuse supplied basic without duplicate RPC calls',async()=>{
  for (const [scan,deep,address,fixture,method] of [[scanBaseTokenBasic,detectBaseEarlyBundlerAndHoneypot,ADDRESS,baseScanRpc(),'eth_getCode'],[scanSolanaTokenBasic,detectSolanaBlock0Bundler,MINT,solScanRpc(),'getTokenLargestAccounts']]) {
    let count=0; const rpc=async(m,p)=>{if(m===method)count++;return fixture(m,p);};
    const basic=await scan(address,{rpc}); assert.equal((await deep(address,{rpc,basic})).basic,basic); assert.equal(count,1);
  }
});
const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1'},capabilities:{}}};
test('13 initialize validates all field types strictly',async()=>{
  for (const params of [{protocolVersion:1},{protocolVersion:''},{clientInfo:[]},{clientInfo:null},{clientInfo:{}},{clientInfo:{name:1}},{capabilities:[]},{capabilities:null},{capabilities:'yes'}]) {
    assert.equal((await createMcpHandler()({...init,params:{...init.params,...params}})).error.code,-32602);
  }
});
test('13 per-line limit accepts a multi-MiB chunk of small lines and rejects oversized lines',async()=>{
  const output=new PassThrough();let text='';output.on('data',d=>text+=d);
  const ping=JSON.stringify({jsonrpc:'2.0',id:2,method:'ping'})+'\n';
  await startMcpServer({input:Readable.from([ping.repeat(25000)]),output});
  assert.equal(text.trim().split('\n').length,25000);assert.ok(!text.includes('error'));
  for(const payload of [' '.repeat(1048577)+'\n', 'é'.repeat(524289)]) {
    const out=new PassThrough();let value='';out.on('data',d=>value+=d);
    await startMcpServer({input:Readable.from([payload]),output:out});assert.equal(JSON.parse(value).error.code,-32600);
  }
});
test('13 stdio ping and cancellation proceed while RPC awaits; signal reaches fetch',async()=>{
  const input=new PassThrough(),output=new PassThrough();const responses=[];let startedResolve,abortedResolve;
  const started=new Promise(r=>startedResolve=r),aborted=new Promise(r=>abortedResolve=r);
  let pingResolve;const ping=new Promise(r=>pingResolve=r);
  output.on('data',d=>{for(const line of String(d).trim().split('\n')) {const value=JSON.parse(line);responses.push(value);if(value.id===3)pingResolve();}});
  const server=startMcpServer({input,output,fetch:async(_,o)=>{startedResolve();return new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>{abortedResolve();reject(o.signal.reason);},{once:true}));}});
  input.write(JSON.stringify(init)+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'scan_token_safety',arguments:{address:ADDRESS,chain:'base'}}})+'\n');
  await started;
  input.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'ping'})+'\n'); await ping;
  input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:2}})+'\n');await aborted;
  input.end();await server;assert.deepEqual(responses.map(r=>r.id),[1,3]);
});
for (const linesPerChunk of [1, 8]) test(`13 stdout backpressure bounds input consumption (${linesPerChunk} lines per chunk)`, async () => {
  const total = 256, responses = [];
  let consumed = 0, blocked = true;
  const input = {
    setEncoding() {},
    async *[Symbol.asyncIterator]() {
      while (consumed < total) {
        let chunk = '';
        for (let i = 0; i < linesPerChunk; i++) {
          chunk += JSON.stringify({ jsonrpc: '2.0', id: consumed++, method: 'ping' }) + '\n';
        }
        yield chunk;
      }
    }
  };
  const output = new EventEmitter();
  output.write = line => { responses.push(JSON.parse(line)); return !blocked; };
  const server = startMcpServer({ input, output });
  try {
    await nextTurn();
    assert.equal(responses.length, 1);
    assert.equal(output.listenerCount('drain'), 1);
    assert.ok(consumed >= 64, 'pings can fill the bounded response window');
    assert.ok(consumed <= 68 + linesPerChunk - 1, `consumed ${consumed} lines before drain`);
    const pausedAt = consumed;
    await nextTurn();
    assert.equal(consumed, pausedAt, 'input remains paused without drain');
  } finally {
    blocked = false;
    output.emit('drain');
    await server;
  }
  assert.equal(consumed, total);
  assert.deepEqual(responses.map(response => response.id), Array.from({ length: total }, (_, id) => id));
  assert.equal(output.listenerCount('drain'), 0);
});
for (const emitClose of [false, true]) for (const withError of [false, true]) test(`13 destroying backpressured stdout settles and removes listeners (emitClose=${emitClose}, error=${withError})`, { timeout: 2000 }, async t => {
  const input = new PassThrough();
  const output = new PassThrough({ highWaterMark: 1, emitClose });
  t.after(() => { input.destroy(); output.destroy(); });
  const server = startMcpServer({ input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  await nextTurn();
  assert.equal(output.listenerCount('drain'), 1, 'response is waiting for drain');
  output.destroy(withError ? new Error('output disconnected') : undefined);
  await server;
  assert.equal(input.destroyed, true);
  for (const event of ['drain', 'close', 'error']) assert.equal(output.listenerCount(event), 0, `${event} listeners cleaned up`);
});
for (const flag of ['destroyed', 'closed', 'writableEnded']) test(`13 stdout ${flag} during write settles without drain`, { timeout: 2000 }, async () => {
  const output = new EventEmitter();
  let writes = 0;
  output.write = () => { writes++; output[flag] = true; return false; };
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n';
  await startMcpServer({ input: Readable.from([ping.repeat(100)]), output });
  assert.equal(writes, 1);
  for (const event of ['drain', 'close', 'error']) assert.equal(output.listenerCount(event), 0);
});
test('13 closing stdout aborts an in-flight handler while input is idle', { timeout: 2000 }, async t => {
  const input = new PassThrough(), output = new PassThrough();
  output.resume();
  t.after(() => { input.destroy(); output.destroy(); });
  let startedResolve, requestSignal;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const server = startMcpServer({ input, output, fetch: async (_, { signal }) => {
    requestSignal = signal;
    startedResolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  input.write(JSON.stringify(init) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'scan_token_safety', arguments: { address: ADDRESS, chain: 'base' } } }) + '\n');
  await started;
  output.destroy();
  await server;
  assert.equal(requestSignal.aborted, true);
  assert.equal(input.destroyed, true);
});
test('17 temporary files fall back within workspace on restricted temp directory',async t=>{
  const dir=await testTemp('cabal-fallback-', {primary:'/unwritable',create:async path=>{if(path.startsWith('/unwritable/'))throw Object.assign(new Error('read only'),{code:'EROFS'});return (await import('node:fs/promises')).mkdtemp(path);}});
  t.after(()=>rm(dir,{recursive:true,force:true}));assert.ok(dir.startsWith(process.cwd()+'/'));
  await assert.rejects(testTemp('x',{create:async()=>{throw Object.assign(new Error('full'),{code:'ENOSPC'});}}),/full/);
});
