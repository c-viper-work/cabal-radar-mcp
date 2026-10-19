import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import { testTemp } from './temp.js';
import { join } from 'node:path';
import * as C from '../src/constants.js';
import { base58Bytes } from '../src/rpc.js';
import { verifyBasePaymentTx, verifySolanaPaymentTx, getMachineChallenge, saveLicense, loadLicense, checkProStatus } from '../src/license.js';
import { HASH, SIG, WALLET, basePayment, solPayment, solTx, tokenBalance, usdcLog } from './fixtures.js';
test('official payment identities and thresholds are exact', () => {
  assert.equal(C.SOLANA_GENESIS, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  assert.equal(base58Bytes(C.SOLANA_GENESIS), 32);
  assert.equal(C.EVM_RECIPIENT, '0x3018577736ebcdd3ddca916Bef44e7dC6E27e33E');
  assert.equal(C.SOLANA_RECIPIENT, 'HFBvBikfatVJgZFyisHTatMdQEJHnJRC1a31fJhoNmGR');
  assert.equal(C.BASE_USDC, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(C.SOLANA_USDC, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(C.MIN_USDC, 15000000n); assert.equal(C.MIN_ETH, 6000000000000000n); assert.equal(C.MIN_SOL, 100000000n);
});
test('Base exact native minimum, recipient case insensitive', async () => {
  const result = await verifyBasePaymentTx(HASH, { rpc: basePayment({ tx: { to: C.EVM_RECIPIENT.toLowerCase() } }) });
  assert.equal(result.asset, 'ETH'); assert.equal(result.amount, C.MIN_ETH.toString());
});
test('Base exact USDC minimum from contract log', async () => {
  const result = await verifyBasePaymentTx(HASH, { rpc: basePayment({ tx: { value: '0x0', to: C.BASE_USDC }, receipt: { logs: [usdcLog()] } }) });
  assert.equal(result.asset, 'USDC');
});
for (const [name, fixture] of Object.entries({ failed: { receipt: { status: '0x0' } }, pending: { tx: { blockNumber: null } }, wrongChain: { chainId: '0x1' }, underpaid: { tx: { value: '0x1' } }, mismatch: { receipt: { transactionHash: `0x${'ff'.repeat(32)}` } }, wrongRecipient: { tx: { to: C.BASE_USDC } } })) test(`Base rejects ${name}`, async () => assert.rejects(verifyBasePaymentTx(HASH, { rpc: basePayment(fixture) })));
for (const [name, mutation] of Object.entries({ underpaid: l => l.data = '0x' + '0'.repeat(63) + '1', wrongToken: l => l.address = C.EVM_RECIPIENT, wrongRecipient: l => l.topics[2] = '0x' + '0'.repeat(64), removed: l => l.removed = true, wrongTopic: l => l.topics[0] = '0x' + '0'.repeat(64), malformed: l => l.data = '0xff' })) test(`Base rejects USDC ${name}`, async () => {
  const log = usdcLog(); mutation(log);
  await assert.rejects(verifyBasePaymentTx(HASH, { rpc: basePayment({ tx: { value: '0x0' }, receipt: { logs: [log] } }) }));
});
test('Base validates transaction hash before RPC', async () => assert.rejects(verifyBasePaymentTx('no')));
test('Solana accepts exact SOL net increase', async () => assert.equal((await verifySolanaPaymentTx(SIG, { rpc: solPayment(solTx()) })).asset, 'SOL'));
test('Solana aggregates USDC across newly created recipient accounts', async () => {
  const tx = solTx({ meta: { postBalances: [0], postTokenBalances: [tokenBalance(WALLET, 7000000, 1), tokenBalance(WALLET, 8000000, 2)] } });
  assert.equal((await verifySolanaPaymentTx(SIG, { rpc: solPayment(tx) })).amount, '15000000');
});
for (const [name, tx] of Object.entries({ failed: solTx({ meta: { err: { InstructionError: [0,'failed'] } } }), missing: null, underpaid: solTx({ meta: { postBalances: [99999999] } }), balanceNotPayment: solTx({ meta: { preBalances: [100000000], postBalances: [100000000] } }), wrongOwner: solTx({ meta: { postBalances: [0], postTokenBalances: [tokenBalance(C.JITO_TIP_ACCOUNTS[0],15000000)] } }), tokenNetBelow: solTx({ meta: { postBalances: [0], preTokenBalances: [tokenBalance(WALLET,1)], postTokenBalances: [tokenBalance(WALLET,15000000)] } }), unsafeInteger: solTx({ meta: { postBalances: [Number.MAX_SAFE_INTEGER+1] } }) })) test(`Solana rejects ${name}`, async () => assert.rejects(verifySolanaPaymentTx(SIG, { rpc: solPayment(tx) })));
test('Solana rejects wrong network and signature', async () => {
  await assert.rejects(verifySolanaPaymentTx(SIG, { rpc: async () => 'wrong' }));
  await assert.rejects(verifySolanaPaymentTx('not-a-signature'));
});
test('machine challenge is deterministic, salted and anonymous', () => {
  assert.deepEqual(getMachineChallenge('a'), getMachineChallenge('a'));
  assert.notEqual(getMachineChallenge('a').machine_id, getMachineChallenge('b').machine_id);
  assert.match(getMachineChallenge().challenge, /^CR-[a-f0-9]{12}$/);
});
test('license re-verifies payment, writes privately, detects tampering and machine changes', async t => {
  const dir = await testTemp('cabal-license-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { licensePath: join(dir,'license.json'), rpc: basePayment(), customSalt: 'unit' };
  assert.equal((await checkProStatus(options)).active, false);
  await saveLicense({ chain: 'base', txHash: HASH }, options);
  assert.equal((await checkProStatus(options)).active, true);
  assert.equal((await stat(options.licensePath)).mode & 0o777, 0o600);
  assert.equal(await loadLicense({ ...options, customSalt: 'other' }), null);
  const record = JSON.parse(await readFile(options.licensePath)); record.txHash = 'tampered';
  await writeFile(options.licensePath, JSON.stringify(record));
  assert.equal(await loadLicense(options), null);
  await assert.rejects(saveLicense({ verified: true, chain: 'base', txHash: HASH }, { ...options, rpc: basePayment({ receipt: { status: '0x0' } }) }));
});
test('Solana supports loaded recipient accounts and rejects mismatched signatures', async () => {
  const tx = solTx({ transaction: { signatures: [SIG], message: { accountKeys: [] } }, meta: { loadedAddresses: { writable: [WALLET], readonly: [] } } });
  assert.equal((await verifySolanaPaymentTx(SIG, { rpc: solPayment(tx) })).asset, 'SOL');
  tx.transaction.signatures = [];
  await assert.rejects(verifySolanaPaymentTx(SIG, { rpc: solPayment(tx) }), /signature mismatch/);
});
test('Solana excludes transfers among the recipient USDC accounts', async () => {
  const tx = solTx({ meta: { postBalances: [0], preTokenBalances: [tokenBalance(WALLET, 15000000, 1)], postTokenBalances: [tokenBalance(WALLET, 15000000, 2)] } });
  await assert.rejects(verifySolanaPaymentTx(SIG, { rpc: solPayment(tx) }));
});
