import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { EVM_RECIPIENT, SOLANA_RECIPIENT } from '../src/constants.js';
test('landing page copies exact recipients and switches accessible MCP configuration', async () => {
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  const ids = new Map();
  const element = (id, text = '', dataset = {}) => {
    const e = { id, textContent: text, dataset, handlers: {}, hidden: false, attributes: {}, addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute(k,v) { this.attributes[k] = v; }, focus() {} };
    ids.set(id,e); return e;
  };
  for (const id of ['toast','cli-panel','mcp-panel','setup-note']) element(id);
  for (const id of ['base-address','solana-address','cli-code','mcp-code']) {
    const match = html.match(new RegExp(`<(?:code|pre)[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/(?:code|pre)>`));
    assert.ok(match, id); element(id, match[1]);
  }
  const tabs = ['cli','mcp'].map(name => element(`${name}-tab`, '', { tab: name }));
  const buttons = [...html.matchAll(/<button[^>]*data-copy-target="([^"]+)"[^>]*>/g)].map((match,index) => element(index === 0 ? 'copy-setup' : `copy-${index}`, '', { copyTarget: match[1] }));
  const copied = [];
  const context = { document: { getElementById: id => ids.get(id), querySelectorAll: query => query === '[data-tab]' ? tabs : buttons }, navigator: { clipboard: { writeText: async text => copied.push(text) } }, setTimeout: () => 1, clearTimeout() {} };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  await buttons[1].handlers.click(); await buttons[2].handlers.click();
  assert.deepEqual(copied,[EVM_RECIPIENT,SOLANA_RECIPIENT]);
  tabs[1].handlers.click(); assert.equal(ids.get('cli-panel').hidden,true); assert.equal(ids.get('mcp-panel').hidden,false); assert.equal(tabs[1].attributes['aria-selected'],'true');
  await buttons[0].handlers.click();
  const config = JSON.parse(copied[2]); assert.equal(config.mcpServers['cabal-radar'].command,'cabal-radar-mcp');
});
