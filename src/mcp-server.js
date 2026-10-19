import { TOOLS, callTool } from './service.js';
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const error = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
export function createMcpHandler(options = {}) {
  let initialized = false;
  const active = new Map(), queue = [];
  let running = 0;
  const drain = () => {
    while (running < 4 && queue.length) {
      const job = queue.shift();
      running++;
      job.run().then(job.resolve, job.reject).finally(() => { running--; drain(); });
    }
  };
  const cancel = id => {
    active.get(id)?.abort();
    const index = queue.findIndex(job => job.id === id);
    if (index !== -1) { queue.splice(index, 1)[0].resolve(null); active.delete(id); }
  };
  return async function handle(message) {
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (Object.hasOwn(message, 'id') && !(typeof message.id === 'string' || Number.isSafeInteger(message.id)))) return error(null, -32600, 'Invalid Request');
    const notification = !Object.hasOwn(message, 'id');
    if (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) return notification ? null : error(message.id, -32602, 'Invalid params');
    if (notification) {
      if (message.method === 'notifications/cancelled') cancel(message.params?.requestId);
      return null;
    }
    const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      if (typeof message.params?.protocolVersion !== 'string' || !message.params.protocolVersion.length || !plain(message.params.clientInfo) || typeof message.params.clientInfo.name !== 'string' || typeof message.params.clientInfo.version !== 'string' || !message.params.clientInfo.version.length || !plain(message.params.capabilities)) return error(message.id, -32602, 'Missing initialization parameters');
      initialized = true;
      return reply({ protocolVersion: VERSIONS.includes(message.params.protocolVersion) ? message.params.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cabal-radar-mcp', version: '1.0.0' }, instructions: 'Read risk limitations and coverage. Never request wallet private keys or sign trades.' });
    }
    if (message.method === 'ping') return reply({});
    if (!initialized) return error(message.id, -32002, 'Server not initialized');
    if (message.method === 'tools/list') return reply({ tools: TOOLS });
    if (message.method === 'tools/call') {
      if (typeof message.params?.name !== 'string') return error(message.id, -32602, 'Tool name is required');
      if (!TOOLS.some(t => t.name === message.params.name)) return error(message.id, -32602, 'Unknown tool');
      if (active.has(message.id)) return error(message.id, -32600, 'Request ID already active');
      if (running >= 4 && queue.length >= 64) return error(message.id, -32000, 'Server busy');
      const controller = new AbortController();
      active.set(message.id, controller);
      return new Promise((resolve, reject) => {
        queue.push({ id: message.id, resolve, reject, run: async () => {
          const abort = () => controller.abort(options.signal.reason);
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener('abort', abort, { once: true });
          try {
            if (controller.signal.aborted) return null;
            const result = await callTool(message.params.name, message.params.arguments ?? {}, { ...options, signal: controller.signal });
            if (controller.signal.aborted) return null;
            return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !!result.error });
          } catch (e) { if (controller.signal.aborted) return null; return reply({ content: [{ type: 'text', text: typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code) ? 'Local license file operation failed' : e.message }], isError: true }); } finally { options.signal?.removeEventListener('abort', abort); active.delete(message.id); }
        } });
        drain();
      });
    }
    return error(message.id, -32601, 'Method not found');
  };
}
export async function startMcpServer({ input = process.stdin, output = process.stdout, ...options } = {}) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const handle = createMcpHandler({ ...options, signal }); let buffer = '';
  const outputEnded = () => output.destroyed || output.closed || output.writableEnded;
  const stop = () => {
    controller.abort();
    input.destroy?.();
  };
  const stopped = () => {
    if (outputEnded() && !controller.signal.aborted) stop();
    return controller.signal.aborted;
  };
  input.setEncoding('utf8');
  let writing = Promise.resolve();
  let queuedWrites = 0, backpressured = false;
  const write = value => {
    if (!value || stopped()) return writing;
    queuedWrites++;
    writing = writing.then(() => writeOne(value)).finally(() => { queuedWrites--; });
    return writing;
  };
  const writeOne = async value => {
    if (!value || stopped()) return;
    if (!output.write(JSON.stringify(value) + '\n')) {
      backpressured = true;
      await new Promise(resolve => {
        const settle = () => {
          clearInterval(checkStopped);
          output.removeListener('drain', settle);
          output.removeListener('close', settle);
          output.removeListener('error', settle);
          resolve();
        };
        // Streams with emitClose: false can be destroyed without emitting an event.
        const checkStopped = setInterval(() => { if (stopped()) settle(); }, 25);
        output.once('drain', settle);
        output.once('close', settle);
        output.once('error', settle);
        if (stopped()) settle();
      });
      backpressured = false;
    }
  };
  const pending = new Set();
  const dispatch = message => {
    const task = handle(message).then(write);
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
  };
  output.on('close', stop);
  output.on('error', stop);
  try {
    if (stopped()) return;
    for await (const chunk of input) {
      if (stopped()) break;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        if (stopped()) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 1024 * 1024) { await write(error(null, -32600, 'Input exceeds 1 MiB')); continue; }
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { await write(error(null, -32700, 'Parse error')); continue; }
        dispatch(message);
        // Let response writes expose backpressure even within a single large chunk.
        await Promise.resolve();
        if (backpressured && (queuedWrites >= 64 || pending.size >= 68)) await writing;
      }
      if (stopped()) break;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { await write(error(null, -32600, 'Input exceeds 1 MiB')); return; }
    }
    if (!stopped() && buffer.trim()) await write(error(null, -32700, 'Unterminated JSON message; newline required'));
  } catch (e) {
    if (!controller.signal.aborted) throw e;
  } finally {
    try { await Promise.all(pending); } finally {
      output.removeListener('close', stop);
      output.removeListener('error', stop);
    }
  }
}
