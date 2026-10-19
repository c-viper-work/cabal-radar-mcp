import { snapshot, restore } from './virtual-fs.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { testTemp } from './temp.js';
import { join } from 'node:path';
import { createMcpHandler, startMcpServer } from '../src/mcp-server.js';
import { callTool } from '../src/service.js';
import { rpcClient, mapLimit } from '../src/rpc.js';
import { saveLicense } from '../src/license.js';
import { handleRequest } from '../cloud-worker/worker.js';
import { HASH, ADDRESS, basePayment, baseScanRpc } from './fixtures.js';
const init = {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}};
const request = (method,params,id=2)=>({jsonrpc:'2.0',id,method,params});
async function temp(t) {const dir=await testTemp('cabal-test-');t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'license.json');}
function cli(args,env={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['bin/cabal-radar.js',...args],{env:{...process.env,...env,CABAL_TEST_VIRTUAL_FS:JSON.stringify(snapshot()),NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${env.NODE_OPTIONS || ''} --import=./test/virtual-fs.js`},stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';
    child.on('message',restore);
    child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
}
test('MCP lifecycle, exactly six tools, notifications and method errors',async()=>{
  const h=createMcpHandler(); assert.equal((await h(request('tools/list'))).error.code,-32002);
  assert.equal((await h(init)).result.serverInfo.version,'1.0.0');
  assert.equal((await h({jsonrpc:'2.0',method:'notifications/initialized'})),null);
  assert.equal((await h(request('tools/list'))).result.tools.length,6);
  assert.deepEqual((await h(request('ping'))).result,{});
  assert.equal((await h(request('unknown'))).error.code,-32601);
  assert.equal((await h([])).error.code,-32600);
  assert.equal((await h(request('tools/call',{name:'missing'}))).error.code,-32602);
});
test('MCP Pro gate, invalid arguments and successful scan',async t=>{
  const h=createMcpHandler({licensePath:await temp(t),rpc:baseScanRpc()});await h(init);
  let result=await h(request('tools/call',{name:'detect_block0_bundler',arguments:{address:ADDRESS,chain:'base'}}));
  assert.equal(result.result.isError,true);assert.match(result.result.content[0].text,/PRO_REQUIRED/);
  result=await h(request('tools/call',{name:'scan_token_safety',arguments:{address:ADDRESS,chain:'base',unexpected:1}})); assert.equal(result.result.isError,true);
  result=await h(request('tools/call',{name:'scan_token_safety',arguments:{address:ADDRESS,chain:'base'}}));assert.equal(result.result.isError,false);assert.equal(JSON.parse(result.result.content[0].text).symbol,'TEST');
});
test('stdio handles malformed and chunked JSON, no notification output',async()=>{
  const output=new PassThrough();let text='';output.on('data',d=>text+=d);
  const payload=JSON.stringify(init)+'\n'+JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\nBAD\n'+JSON.stringify(request('ping'))+'\n';
  await startMcpServer({input:Readable.from([payload.slice(0,20),payload.slice(20)]),output});
  const lines=text.trim().split('\n').map(JSON.parse);assert.equal(lines.length,3);assert.equal(lines.find(r=>r.error)?.error.code,-32700);assert.deepEqual(lines.find(r=>r.id===2).result,{});
});
test('stdio enforces bounded input',async()=>{
  const output=new PassThrough();let text='';output.on('data',d=>text+=d);
  await startMcpServer({input:Readable.from(['a'.repeat(1024*1024+1)]),output});assert.equal(JSON.parse(text).error.code,-32600);
});
test('activated Pro batch produces JSON and Markdown with per-token errors',async t=>{
  const licensePath=await temp(t);await saveLicense({chain:'base',txHash:HASH},{licensePath,rpc:basePayment()});
  let codeReads=0;const fixture=baseScanRpc();const countedRpc=async(m,p)=>{if(m==='eth_getCode')codeReads++;return fixture(m,p);};
  const result=await callTool('batch_audit_watchlist',{tokens:[{address:ADDRESS,chain:'base'},{address:'invalid',chain:'base'}],format:'markdown'},{licensePath,rpc:countedRpc});
  assert.equal(codeReads,1);
  assert.equal(result.results[0].basic.symbol,'TEST');assert.ok(result.results[1].error);assert.match(result.markdown,/\| base \|/);
});
test('concurrent scheduler respects limit and preserves order',async()=>{
  let active=0,peak=0;
  const r=await mapLimit([1,2,3,4,5],2,async n=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return n*2;});
  assert.equal(peak,2);assert.deepEqual(r,[2,4,6,8,10]);
});
test('RPC enforces HTTP and JSON-RPC envelope, suppresses endpoint secrets',async()=>{
  await assert.rejects(rpcClient('base',{fetch:async()=>({ok:false,status:429})})('eth_call'),/429/);
  await assert.rejects(rpcClient('base',{fetch:async()=>{throw new Error('secret-url');}})('eth_call'),e=>!e.message.includes('secret-url'));
  await assert.rejects(rpcClient('base',{fetch:async()=>({ok:true,json:async()=>({jsonrpc:'2.0',id:99,result:1})})})('eth_call'),/envelope/);
  const rpc=rpcClient('base',{fetch:async(_,o)=>({ok:true,json:async()=>({jsonrpc:'2.0',id:JSON.parse(o.body).id,result:42})})});assert.equal(await rpc('test'),42);
});
test('CLI help, version, upgrade, status and invalid invocation',async t=>{
  const env={CABAL_RADAR_LICENSE_PATH:await temp(t)};
  for(const args of [['--help'],['--version'],['upgrade'],['status']]){const r=await cli(args,env);assert.equal(r.code,0);assert.equal(r.stderr,'');}
  const upgrade=JSON.parse((await cli(['upgrade'],env)).stdout);assert.equal(upgrade.payments.base.usdc.minimum,'15000000');
  for(const args of [['unknown'],['scan'],['activate','--tx',HASH],['status','--chain','base'],['scan',ADDRESS,'--chain','wrong']])assert.equal((await cli(args,env)).code,1);
  const gated=await cli(['scan',ADDRESS,'--chain','base','--pro','--json'],env);assert.equal(gated.code,1);assert.match(gated.stdout,/PRO_REQUIRED/);
});
test('spawned CLI activation and scan through serialized JSON-RPC fixtures',async t=>{
  const licensePath=await temp(t);
  const env={CABAL_RADAR_LICENSE_PATH:licensePath,BASE_RPC_URL:'https://rpc.example.test',NODE_OPTIONS:'--import=./test/cli-rpc-preload.js'};
  const activated=await cli(['activate','--tx',HASH,'--chain','base'],env);assert.equal(activated.code,0,activated.stderr);assert.equal(JSON.parse(activated.stdout).active,true);
  const scanned=await cli(['scan',ADDRESS,'--chain','base','--json'],env);assert.equal(scanned.code,0,scanned.stderr);assert.equal(JSON.parse(scanned.stdout).symbol,'TEST');
  const deep=await cli(['scan',ADDRESS,'--chain','base','--pro','--json'],env);assert.equal(deep.code,0,deep.stderr);assert.equal(JSON.parse(deep.stdout).deep.honeypotVerdict,'UNKNOWN');
});
test('Worker 402 instructions and paid scan, no client-selectable RPC',async()=>{
  const url='https://example.test/scan';
  const required=await handleRequest(new Request(url,{method:'POST'}));assert.equal(required.status,402);assert.equal((await required.json()).scheme,'onchain-receipt-v1');
  const headers={'content-type':'application/json','x-payment-tx':HASH,'x-payment-chain':'base'};
  let codeReads=0;const fixture=baseScanRpc();
  const injected={paymentOptions:{rpc:basePayment()},scanOptions:{rpc:async(m,p)=>{if(m==='eth_getCode')codeReads++;return fixture(m,p);}}};
  const response=await handleRequest(new Request(url,{method:'POST',headers,body:JSON.stringify({chain:'base',address:ADDRESS})}),{},injected);assert.equal(response.status,200);assert.equal((await response.json()).basic.symbol,'TEST');assert.equal(codeReads,1);
  const invalid=await handleRequest(new Request(url,{method:'POST',headers,body:JSON.stringify({chain:'base',address:ADDRESS,rpcUrl:'https://example.test'})}),{},injected);assert.equal(invalid.status,400);
  const failed=await handleRequest(new Request(url,{method:'POST',headers,body:'{}'}),{},{paymentOptions:{rpc:basePayment({receipt:{status:'0x0'}})}});assert.equal(failed.status,402);
});
