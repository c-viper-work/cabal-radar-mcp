import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSolanaTokenBasic, detectSolanaBlock0Bundler, traceSolanaFundingClusters } from '../src/solana-scanner.js';
import { scanBaseTokenBasic, inspectBytecode, detectBaseEarlyBundlerAndHoneypot } from '../src/base-scanner.js';
import { keccak256, selector } from '../src/keccak.js';
import { RpcError, raw, solanaAddress } from '../src/rpc.js';
import * as C from '../src/constants.js';
import { MINT, WALLET, OTHER, THIRD, ADDRESS, HASH, word, topic, solTx, solScanRpc, baseScanRpc, tokenBalance } from './fixtures.js';
test('Ethereum keccak known vectors and ABI selector', () => {
  assert.equal(keccak256(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(selector('transfer(address,uint256)'), 'a9059cbb');
  assert.equal('0x'+keccak256('Transfer(address,address,uint256)'), C.TRANSFER_TOPIC);
});
test('exact integer and address validation', () => {
  assert.throws(() => raw(Number.MAX_SAFE_INTEGER+1)); assert.throws(() => raw('-1'));
  assert.throws(() => solanaAddress('1'.repeat(31))); assert.equal(solanaAddress(MINT), MINT);
  C.JITO_TIP_ACCOUNTS.forEach(solanaAddress);
});
test('Solana free calculates exact account percentages', async () => {
  const result = await scanSolanaTokenBasic(MINT, { rpc: solScanRpc() });
  assert.equal(result.top10HolderPct, 10); assert.equal(result.largestHolderPct, 10); assert.equal(result.safetyScore, 100);
});
test('Solana dangerous Token-2022 extensions and authorities', async () => {
  const result = await scanSolanaTokenBasic(MINT, { rpc: solScanRpc({ owner: C.TOKEN_2022_PROGRAM_ID, info: { mintAuthority: WALLET, freezeAuthority: WALLET, extensions: [{ extension: 'permanentDelegate' }, { extension: 'transferHook', state: { programId: WALLET } }, { extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 1500 } } }] } }) });
  assert.equal(result.isToken2022, true); assert.equal(result.dangerousExtensions.length, 3); assert.equal(result.riskLevel, 'CRITICAL');
});
test('Solana rejects a non-mint and bad address', async () => {
  await assert.rejects(scanSolanaTokenBasic(OTHER, { rpc: solScanRpc() })); await assert.rejects(scanSolanaTokenBasic('bad'));
});
test('Solana detects same-window acquisitions and an actual Jito transfer', async () => {
  const tx = (wallet, slot, tip) => solTx({ slot, meta: { postTokenBalances: [tokenBalance(wallet, 100)] }, transaction: { message: { instructions: tip ? [{ program: 'system', parsed: { type: 'transfer', info: { destination: C.JITO_TIP_ACCOUNTS[2], lamports: 1000 } } }] : [] } } });
  const rpc = solScanRpc({ history: [{ signature: 'a',slot: 10,err:null },{ signature:'b',slot:12,err:null }], transactions: { a: tx(WALLET,10,true), b: tx(OTHER,12,false) } });
  const result = await detectSolanaBlock0Bundler(MINT,{rpc});
  assert.equal(result.bundleClusterCount,1); assert.equal(result.bundledSupplyPct,10); assert.equal(result.clusters[0].jitoTipObserved,true); assert.equal(result.coverage.launchVerified,false);
});
test('Solana insufficient history does not claim no bundle', async () => {
  const result = await detectSolanaBlock0Bundler(MINT,{rpc:solScanRpc()}); assert.equal(result.bundlerVerdict,'INSUFFICIENT_EVIDENCE');
});
test('funding clusters use parsed inbound transfers, not mere account co-occurrence', async () => {
  const rpc = solScanRpc({ history: p => [{signature:p[0],slot:10,err:null}], transactions: Object.fromEntries([WALLET,OTHER].map(holder => [holder,solTx({transaction:{message:{instructions:[{program:'system',parsed:{type:'transfer',info:{source:THIRD,destination:holder,lamports:1000000}}}]}}})])) });
  const result = await traceSolanaFundingClusters([WALLET,OTHER],{rpc}); assert.equal(result.sybilClusterPct,100); assert.deepEqual(result.motherWallets,[THIRD]);
});
test('funding rejects oversized input', async () => assert.rejects(traceSolanaFundingClusters(Array(21).fill(WALLET))));
test('Base free reads ERC20 metadata', async () => {
  const result = await scanBaseTokenBasic(ADDRESS,{rpc:baseScanRpc()}); assert.equal(result.symbol,'TEST'); assert.equal(result.supply,'1000000'); assert.equal(result.decimals,18);
});
test('opcode inspection skips PUSH data and finds actual controls', () => {
  assert.equal(inspectBytecode('0x61fff400').flags.length,0);
  const r = inspectBytecode(`0xfff463${selector('blacklist(address)')}63${selector('setTax(uint256)')}63${selector('pause()')}63${selector('mint(address,uint256)')}`);
  assert.deepEqual(r.flags.map(f=>f.code),['SELFDESTRUCT','DELEGATECALL','BLACKLIST','MUTABLE_TAX','PAUSABLE','MINT']);
});
test('Base nonexistent contract and malformed address fail', async () => {
  await assert.rejects(scanBaseTokenBasic(ADDRESS,{rpc:baseScanRpc({code:'0x'})})); await assert.rejects(scanBaseTokenBasic('0x123'));
});
test('Base transport errors are not silently downgraded to safe metadata', async () => {
  await assert.rejects(scanBaseTokenBasic(ADDRESS,{rpc:baseScanRpc({calls:{['0x'+selector('owner()')]:new RpcError('network failure')}})}), /network failure/);
});
test('Base earliest logs and honeypot uncertainty are reported', async () => {
  const logs = [1,2,3].map((n,i)=>({address:ADDRESS,topics:[C.TRANSFER_TOPIC,topic(C.EVM_RECIPIENT),`0x${word(n)}`],data:`0x${word(100)}`,blockNumber:'0x10',transactionHash:HASH,logIndex:`0x${i}`}));
  const result = await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{rpc:baseScanRpc({logs})});
  assert.equal(result.earlyWalletCount,3); assert.equal(result.honeypotVerdict,'UNKNOWN'); assert.equal(result.transferTax.sellPct,null); assert.equal(result.coverage.launchVerified,false);
});
test('Base failed transfer call is review required, not proof of honeypot', async () => {
  const from=ADDRESS,to=C.EVM_RECIPIENT,data=`0xa9059cbb${to.slice(2).toLowerCase().padStart(64,'0')}${word(1)}`;
  const result=await detectBaseEarlyBundlerAndHoneypot(ADDRESS,{rpc:baseScanRpc({calls:{[data]:new RpcError('revert',3)}}),simulationFrom:from,simulationTo:to,simulationAmount:'1'});
  assert.equal(result.transferSimulation.status,'REVERTED'); assert.equal(result.honeypotVerdict,'REVIEW_REQUIRED');
});
