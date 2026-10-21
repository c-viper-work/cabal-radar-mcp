import * as C from '../src/constants.js';
import { selector } from '../src/keccak.js';
export const HASH = `0x${'ab'.repeat(32)}`, BLOCK = `0x${'cd'.repeat(32)}`;
export const SIG = '1'.repeat(64), MINT = C.SOLANA_USDC, WALLET = C.SOLANA_RECIPIENT;
export const OTHER = C.JITO_TIP_ACCOUNTS[0], THIRD = C.JITO_TIP_ACCOUNTS[1];
export const ADDRESS = `0x${'12'.repeat(20)}`;
export const word = n => BigInt(n).toString(16).padStart(64,'0');
export const topic = a => `0x${a.slice(2).toLowerCase().padStart(64,'0')}`;
export function basePayment(overrides = {}) {
  const tx = { hash: HASH, to: C.EVM_RECIPIENT, value: `0x${C.MIN_ETH.toString(16)}`, blockNumber: '0x10', blockHash: BLOCK, ...overrides.tx };
  const receipt = { status: '0x1', transactionHash: HASH, blockNumber: '0x10', blockHash: BLOCK, logs: [], ...overrides.receipt };
  return async method => ({ eth_chainId: overrides.chainId || C.BASE_CHAIN_ID, eth_getTransactionByHash: tx, eth_getTransactionReceipt: receipt })[method];
}
export function usdcLog(amount = C.MIN_USDC) { return { address: C.BASE_USDC, topics: [C.TRANSFER_TOPIC, topic(ADDRESS), topic(C.EVM_RECIPIENT)], data: `0x${word(amount)}` }; }
export function solTx(overrides = {}) {
  const { meta, transaction, ...rest } = overrides;
  return { slot: 10, blockTime: 100, transaction: { signatures: [SIG], ...transaction, message: { accountKeys: [{ pubkey: WALLET }], instructions: [], ...transaction?.message } }, meta: { err: null, preBalances: [0], postBalances: [Number(C.MIN_SOL)], preTokenBalances: [], postTokenBalances: [], ...meta }, ...rest };
}
export const solPayment = tx => async method => method === 'getGenesisHash' ? C.SOLANA_GENESIS : tx;
export const tokenBalance = (owner, amount, index = 0) => ({ mint: MINT, owner, accountIndex: index, uiTokenAmount: { amount: String(amount), decimals: 6 } });
export function solScanRpc({ info = {}, history = [], transactions = {}, largest = [{ address: OTHER, amount: '100' }], owner = C.TOKEN_PROGRAM_ID } = {}) {
  return async (method, params) => {
    if (method === 'getGenesisHash') return C.SOLANA_GENESIS;
    if (method === 'getAccountInfo') return { value: { owner, data: { parsed: params[0] === MINT ? { type: 'mint', info: { supply: '1000', decimals: 6, mintAuthority: null, freezeAuthority: null, ...info } } : { type: 'account', info: { owner: WALLET } } } } };
    if (method === 'getTokenLargestAccounts') return { value: largest };
    if (method === 'getSignaturesForAddress') return typeof history === 'function' ? history(params) : history;
    if (method === 'getTransaction') return transactions[params[0]] ?? null;
    throw new Error(`Unexpected method ${method}`);
  };
}
export function baseScanRpc({ code = '0x60006000', logs = [], calls = {}, latest = '0x20' } = {}) {
  return async (method, params) => {
    if (method === 'eth_chainId') return C.BASE_CHAIN_ID;
    if (method === 'eth_getCode') return code;
    if (method === 'eth_blockNumber') return latest;
    if (method === 'eth_getLogs') return logs;
    if (method === 'eth_call') {
      const data = params[0].data;
      if (Object.hasOwn(calls, data)) { if (calls[data] instanceof Error) throw calls[data]; return calls[data]; }
      return ({ [selector('totalSupply()')]: `0x${word(1000000)}`, [selector('owner()')]: `0x${word(0)}`, [selector('symbol()')]: `0x${'54455354'.padEnd(64,'0')}`, [selector('decimals()')]: `0x${word(18)}` })[data.slice(2)] ?? `0x${word(1)}`;
    }
    throw new Error(`Unexpected method ${method}`);
  };
}
