import { EVM_RECIPIENT, SOLANA_RECIPIENT, BASE_USDC, SOLANA_USDC, MIN_USDC, MIN_ETH, MIN_SOL, TRANSFER_TOPIC, BASE_CHAIN_ID, SOLANA_GENESIS } from './constants.js';
import { rpcClient, raw, base58Bytes } from './rpc.js';
const eq = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
export async function verifyBasePaymentTx(txHash, options = {}) {
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('Invalid Base transaction hash');
  const rpc = rpcClient('base', options);
  if (!eq(await rpc('eth_chainId'), BASE_CHAIN_ID)) throw new Error('RPC is not Base mainnet');
  const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [txHash]), rpc('eth_getTransactionReceipt', [txHash])]);
  if (!tx || !receipt || receipt.status !== '0x1' || !receipt.blockNumber || !tx.blockNumber) throw new Error('Payment is missing, pending or failed');
  if (!eq(tx.hash, txHash) || !eq(receipt.transactionHash, txHash) || tx.blockNumber !== receipt.blockNumber || !eq(tx.blockHash, receipt.blockHash)) throw new Error('Payment transaction/receipt mismatch');
  let asset, amount;
  if (eq(tx.to, EVM_RECIPIENT) && raw(tx.value) >= MIN_ETH) { asset = 'ETH'; amount = raw(tx.value); }
  else {
    const log = (receipt.logs || []).find(l => !l.removed && eq(l.address, BASE_USDC) && l.topics?.length === 3 && eq(l.topics[0], TRANSFER_TOPIC) && eq(l.topics[2], `0x${'0'.repeat(24)}${EVM_RECIPIENT.slice(2)}`) && /^0x[0-9a-fA-F]{64}$/.test(l.data) && raw(l.data) >= MIN_USDC);
    if (log) { asset = 'USDC'; amount = raw(log.data); }
  }
  if (!asset) throw new Error('No qualifying Base payment to the official recipient');
  return { verified: true, chain: 'base', txHash: txHash.toLowerCase(), asset, amount: amount.toString(), recipient: EVM_RECIPIENT, blockNumber: receipt.blockNumber };
}
export async function verifySolanaPaymentTx(signature, options = {}) {
  if (base58Bytes(signature) !== 64) throw new Error('Invalid Solana signature');
  const rpc = rpcClient('solana', options);
  if (await rpc('getGenesisHash') !== SOLANA_GENESIS) throw new Error('RPC is not Solana mainnet');
  const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (!tx?.meta || tx.meta.err !== null || !Number.isSafeInteger(tx.slot)) throw new Error('Payment is missing, pending or failed');
  if (!tx.transaction?.signatures?.includes(signature)) throw new Error('Payment signature mismatch');
  const keys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey);
  // jsonParsed includes loaded lookup-table accounts; raw JSON may require these appended.
  if (keys.length < tx.meta.postBalances.length) keys.push(...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || []));
  const index = keys.indexOf(SOLANA_RECIPIENT);
  if (index >= 0) {
    const amount = raw(tx.meta.postBalances[index]) - raw(tx.meta.preBalances[index]);
    if (amount >= MIN_SOL) return { verified: true, chain: 'solana', txHash: signature, asset: 'SOL', amount: amount.toString(), recipient: SOLANA_RECIPIENT, slot: tx.slot };
  }
  const sum = balances => (balances || []).filter(b => b.mint === SOLANA_USDC && b.owner === SOLANA_RECIPIENT && b.uiTokenAmount?.decimals === 6).reduce((n, b) => n + raw(b.uiTokenAmount.amount), 0n);
  const amount = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  if (amount < MIN_USDC) throw new Error('No qualifying Solana payment to the official recipient');
  return { verified: true, chain: 'solana', txHash: signature, asset: 'USDC', amount: amount.toString(), recipient: SOLANA_RECIPIENT, slot: tx.slot };
}
