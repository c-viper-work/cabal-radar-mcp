// Test-only filesystem adapter. Real paths always retain native filesystem semantics.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const roots = new Set(), files = new Map();
let installed = false;
export const snapshot = () => ({ roots: [...roots], files: [...files] });
export function restore(value) {
  for (const root of value.roots) roots.add(root);
  for (const [path, file] of value.files) files.set(path, file);
  install();
}
export function virtualTemp(prefix, parent = process.cwd()) {
  const root = join(parent, `.${prefix}virtual-${randomUUID()}`);
  roots.add(root); install(); return root;
}
const failure = code => Object.assign(new Error(code), { code });
function install() {
  if (installed) return;
  installed = true;
  const virtual = path => [...roots].some(root => String(path) === root || String(path).startsWith(root + '/'));
  const handlers = {
    mkdir: async () => undefined,
    readFile: async (path, encoding) => { const f = files.get(path); if (!f) throw failure('ENOENT'); return encoding ? f.data : Buffer.from(f.data); },
    writeFile: async (path, data, options) => { if (options?.flag === 'wx' && files.has(path)) throw failure('EEXIST'); files.set(path, { data: String(data), mode: files.get(path)?.mode ?? options?.mode ?? 0o666 }); },
    rename: async (from, to) => { if (!virtual(to)) throw failure('EXDEV'); if (!files.has(from)) throw failure('ENOENT'); files.set(to, files.get(from)); files.delete(from); },
    unlink: async path => { if (!files.delete(path)) throw failure('ENOENT'); },
    stat: async path => { if (!files.has(path)) throw failure('ENOENT'); return { mode: files.get(path).mode }; },
    rm: async path => { for (const key of files.keys()) if (key === path || key.startsWith(path + '/')) files.delete(key); roots.delete(path); }
  };
  for (const [method, handler] of Object.entries(handlers)) {
    const native = fs[method];
    fs[method] = (...args) => virtual(args[0]) ? handler(...args) : native(...args);
  }
  syncBuiltinESMExports();
}
if (process.env.CABAL_TEST_VIRTUAL_FS) {
  restore(JSON.parse(process.env.CABAL_TEST_VIRTUAL_FS));
  process.once('beforeExit', () => { if (process.connected) process.send(snapshot()); });
}
