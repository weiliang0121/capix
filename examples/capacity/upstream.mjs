import { createServer } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expectedAnswer } from './upstream-client.mjs';

// This process is a controlled provider, not the service under measurement. It
// serves no public interfaces, consumes no environment configuration or secrets.
if (!process.send) throw new Error('Capacity upstream must be started through upstream-client.mjs');
const stats = { requests: 0, answers: 0, memories: 0, active: 0, peakActive: 0, completed: 0, aborted: 0, failed: 0, requestBytes: 0, responseBytes: 0, backpressureWrites: 0, firstChunkDelayMsTotal: 0, answerElapsedMsTotal: 0 };
const initialCpu = process.cpuUsage();
const initialTime = performance.now();
const eventLoop = monitorEventLoopDelay({ resolution: 10 });
eventLoop.enable();
const durations = {
  answer: { count: 0, totalMs: 0, maxMs: 0 },
  memory: { count: 0, totalMs: 0, maxMs: 0 },
  firstChunk: { count: 0, totalMs: 0, maxMs: 0 },
};
const active = new Map();
let configuration;
let server;
let closing = false;

process.on('message', (message) => {
  try {
    if (message?.kind === 'initialize') initialize(message.configuration);
    else if (message?.kind === 'snapshot') process.send({ kind: 'reply', id: message.id, stats: snapshot() });
    else if (message?.kind === 'close') close(message.id);
    else throw new Error('Unknown capacity upstream control message');
  } catch (error) {
    process.send({ kind: 'error', message: error.message });
  }
});
process.on('disconnect', () => {
  eventLoop.disable();
  for (const stop of active.values()) stop.abort(new Error('Capacity controller disconnected'));
  server?.closeAllConnections();
  server?.close();
});

function initialize(options) {
  if (configuration) throw new Error('Capacity upstream is already initialized');
  configuration = { answerMs: 1000, chunks: 20, outputBytes: 2048, memoryMs: 100, ...options };
  for (const [name, max] of [
    ['answerMs', 60_000],
    ['chunks', 1024],
    ['outputBytes', 1024 * 1024],
    ['memoryMs', 60_000],
  ]) {
    const value = configuration[name];
    if (!Number.isSafeInteger(value) || value < (name === 'memoryMs' ? 0 : 1) || value > max) throw new Error(`Invalid upstream ${name}`);
  }
  server = createServer((request, response) => {
    void handle(request, response);
  });
  server.on('error', (error) => process.send({ kind: 'error', message: error.message }));
  server.listen(0, '127.0.0.1', () => {
    process.send({ kind: 'ready', endpoint: `http://127.0.0.1:${server.address().port}/chat/completions` });
  });
}

async function handle(request, response) {
  if (closing || request.method !== 'POST' || request.url !== '/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  const id = ++stats.requests;
  const stop = new AbortController();
  active.set(id, stop);
  stats.active++;
  stats.peakActive = Math.max(stats.peakActive, stats.active);
  const disconnect = () => {
    if (!response.writableFinished) stop.abort(new Error('Capacity request disconnected'));
  };
  response.once('close', disconnect);
  let finished = false;
  try {
    const body = await readBody(request, stop.signal);
    const started = performance.now();
    const reply = (text, finishReason = 'stop') => ({ id: `capacity-${id}`, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }] });
    if (body.response_format?.type === 'json_object' && body.stream !== true) {
      stats.memories++;
      await delay(configuration.memoryMs, undefined, { signal: stop.signal });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      await write(response, JSON.stringify(reply('{"changes":[]}')), stop.signal);
      sample(durations.memory, performance.now() - started);
    } else if (body.stream === true && body.response_format?.type === 'text') {
      stats.answers++;
      const material = JSON.parse(body.messages.findLast((message) => message.role === 'user').content);
      if (typeof material.query?.content !== 'string') throw new Error('Capacity answer request requires a query');
      const text = expectedAnswer(material.query.content, configuration.outputBytes);
      // Slice code points, so a synthetic chunk never splits a Unicode surrogate.
      const points = Array.from(text);
      const count = Math.min(configuration.chunks, points.length);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      response.flushHeaders();
      for (let index = 0; index < count; index++) {
        const due = started + (configuration.answerMs * (index + 1)) / count;
        await delay(Math.max(0, due - performance.now()), undefined, { signal: stop.signal });
        const fragment = points.slice(Math.floor((points.length * index) / count), Math.floor((points.length * (index + 1)) / count)).join('');
        const chunk = { id: `capacity-${id}`, model: body.model, choices: [{ index: 0, delta: { content: fragment }, finish_reason: null }] };
        if (index === 0) {
          const elapsed = performance.now() - started;
          stats.firstChunkDelayMsTotal += elapsed;
          sample(durations.firstChunk, elapsed);
        }
        await write(response, `data: ${JSON.stringify(chunk)}\n\n`, stop.signal);
      }
      const terminal = { id: `capacity-${id}`, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      await write(response, `data: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`, stop.signal);
      const elapsed = performance.now() - started;
      stats.answerElapsedMsTotal += elapsed;
      sample(durations.answer, elapsed);
    } else throw new Error('Unexpected capacity provider request');
    stop.signal.throwIfAborted();
    response.end();
    finished = true;
    stats.completed++;
  } catch {
    if (stop.signal.aborted || request.aborted || response.destroyed) stats.aborted++;
    else {
      stats.failed++;
      if (!response.headersSent) response.writeHead(400).end('Invalid capacity request');
      else response.destroy();
    }
  } finally {
    response.removeListener('close', disconnect);
    if (!finished && !response.destroyed && !response.writableEnded) response.destroy();
    active.delete(id);
    stats.active--;
  }
}

async function readBody(request, signal) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new Error('Capacity request exceeds 4 MiB');
    stats.requestBytes += chunk.length;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function write(response, text, signal) {
  signal.throwIfAborted();
  if (response.destroyed) throw new Error('Capacity response is closed');
  const bytes = Buffer.from(text);
  stats.responseBytes += bytes.length;
  if (response.write(bytes)) return;
  stats.backpressureWrites++;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener('drain', drain);
      response.removeListener('error', failed);
      signal.removeEventListener('abort', abort);
    };
    const drain = () => {
      cleanup();
      resolve();
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const abort = () => failed(signal.reason);
    response.once('drain', drain);
    response.once('error', failed);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function snapshot() {
  const latency = Object.fromEntries(Object.entries(durations).map(([kind, value]) => [kind, { ...value, meanMs: value.count ? value.totalMs / value.count : null }]));
  return {
    ...stats,
    elapsedMs: performance.now() - initialTime,
    cpu: process.cpuUsage(initialCpu),
    memory: process.memoryUsage(),
    // Producer-side durations cover HTTP body accepted -> final write queued;
    // the measured service separately records preview delivery and final reply.
    latency,
    eventLoopDelayMs: {
      mean: Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1e6 : null,
      p95: eventLoop.percentile(95) / 1e6,
      p99: eventLoop.percentile(99) / 1e6,
      max: eventLoop.max / 1e6,
    },
  };
}

function sample(target, milliseconds) {
  target.count++;
  target.totalMs += milliseconds;
  target.maxMs = Math.max(target.maxMs, milliseconds);
}

function close(id) {
  if (closing) throw new Error('Capacity upstream close already requested');
  closing = true;
  eventLoop.disable();
  for (const stop of active.values()) stop.abort(new Error('Capacity upstream shutting down'));
  if (!server) return process.send({ kind: 'reply', id, stats: snapshot() }, () => process.disconnect());
  server.close(() => {
    // Aborted request promises finish their finally handlers in a microtask.
    setImmediate(() => process.send({ kind: 'reply', id, stats: snapshot() }, () => process.disconnect()));
  });
  server.closeAllConnections();
}
