// Fault injection for running the full suite without any writable filesystem.
// Usage: NODE_OPTIONS="--import=./test/readonly-preload.js" npm test
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
for (const method of ['mkdtemp', 'mkdir', 'writeFile', 'rename', 'unlink', 'rm']) {
  fs[method] = async () => { throw Object.assign(new Error('Read-only test filesystem'), { code: 'EROFS' }); };
}
syncBuiltinESMExports();
