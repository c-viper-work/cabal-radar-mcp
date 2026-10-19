import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);

test('Dockerfile and Glama metadata support MCP directory introspection', () => {
  const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8');
  const glama = JSON.parse(readFileSync(new URL('glama.json', root), 'utf8'));
  assert.ok(Array.isArray(glama.maintainers) && glama.maintainers.length > 0);
  assert.deepEqual(dockerfile.split(/\r?\n/).map(line => line.trim()).filter(Boolean), [
    'FROM node:22-alpine',
    'WORKDIR /app',
    'COPY package.json ./',
    'COPY bin ./bin',
    'COPY src ./src',
    'ENV NODE_ENV=production',
    'ENTRYPOINT ["node", "bin/cabal-radar.js", "--mcp"]',
  ]);
  const dockerignore = readFileSync(new URL('.dockerignore', root), 'utf8')
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const exclusion of ['.env', '.env.*', '.cabal-radar/', 'license.json', '.wrangler/']) {
    assert.ok(dockerignore.includes(exclusion), `Missing Docker build exclusion: ${exclusion}`);
  }
  const entrypoint = JSON.parse(dockerfile.match(/^ENTRYPOINT (.+)$/m)?.[1] ?? 'null');
  assert.deepEqual(entrypoint, ['node', 'bin/cabal-radar.js', '--mcp']);

  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'directory-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ];
  const result = spawnSync(process.execPath, entrypoint.slice(1), {
    cwd: root,
    input: messages.map(message => JSON.stringify(message)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, NODE_ENV: 'production' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const responses = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses.length, 2);
  assert.ok(responses.find(response => response.id === 1)?.result.serverInfo);
  assert.equal(responses.find(response => response.id === 2)?.result.tools.length, 6);
});

test('--mcp cannot be combined with another CLI command', () => {
  const result = spawnSync(process.execPath, ['bin/cabal-radar.js', 'status', '--mcp'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--mcp is not valid for status/);
});
