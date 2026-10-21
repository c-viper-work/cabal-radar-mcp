import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { hostname, homedir, platform, arch } from 'node:os';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifyBasePaymentTx, verifySolanaPaymentTx } from './payments.js';
export { verifyBasePaymentTx, verifySolanaPaymentTx } from './payments.js';
export function getMachineChallenge(customSalt = '') {
  const machine_id = createHash('sha256').update(JSON.stringify(['cabal-radar-v1', process.env.CABAL_RADAR_MACHINE_ID || homedir(), platform(), arch(), customSalt])).digest('hex').slice(0, 12);
  return { machine_id, challenge: `CR-${machine_id}` };
}
const pathFor = o => o.licensePath || process.env.CABAL_RADAR_LICENSE_PATH || join(homedir(), '.cabal-radar', 'license.json');
const signature = (record, machineId) => createHmac('sha256', createHash('sha256').update(`cabal-radar-integrity-v1:${machineId}`).digest()).update(JSON.stringify([record.version, record.machine_id, record.txHash, record.chain])).digest('hex');
export async function saveLicense(proof, options = {}) {
  // Never trust a caller-supplied verified flag: save only after independent RPC verification.
  const verify = proof.chain === 'base' ? verifyBasePaymentTx : proof.chain === 'solana' ? verifySolanaPaymentTx : null;
  if (!verify) throw new Error('Unsupported payment chain');
  const payment = await verify(proof.txHash, options);
  const record = { version: 1, machine_id: getMachineChallenge(options.customSalt).machine_id, txHash: payment.txHash, chain: payment.chain };
  record.integrity = signature(record, record.machine_id);
  const file = pathFor(options), temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
  return { ...record, payment };
}
export async function loadLicense(options = {}) {
  try {
    const record = JSON.parse(await readFile(pathFor(options), 'utf8'));
    const legacyId = createHash('sha256').update(JSON.stringify(['cabal-radar-v1', hostname(), homedir(), platform(), arch(), ''])).digest('hex').slice(0, 12);
    const validMachine = record.machine_id === getMachineChallenge(options.customSalt).machine_id || ((options.customSalt === undefined || options.customSalt === '') && !process.env.CABAL_RADAR_MACHINE_ID && record.machine_id === legacyId);
    if (record.version !== 1 || !validMachine || !['base', 'solana'].includes(record.chain) || typeof record.txHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.integrity || '')) return null;
    if (!timingSafeEqual(Buffer.from(record.integrity, 'hex'), Buffer.from(signature(record, record.machine_id), 'hex'))) return null;
    return record;
  } catch { return null; }
}
export async function checkProStatus(options = {}) {
  const license = await loadLicense(options);
  return { active: !!license, tier: license ? 'Pro' : 'Free', ...getMachineChallenge(options.customSalt), ...(license ? { chain: license.chain, txHash: license.txHash } : {}) };
}
