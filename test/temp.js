import { virtualTemp } from './virtual-fs.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function testTemp(prefix, { primary = tmpdir(), fallback = process.cwd(), create = mkdtemp } = {}) {
  try { return await create(join(primary, prefix)); }
  catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
    try { return await create(join(fallback, `.${prefix}`)); }
    catch (fallbackError) {
      if (!['EACCES', 'EPERM', 'EROFS'].includes(fallbackError.code)) throw fallbackError;
      return virtualTemp(prefix, fallback);
    }
  }
}
