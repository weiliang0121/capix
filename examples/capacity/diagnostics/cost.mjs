import { closeSync, openSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { Invocation } from '@capix/invocation';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { ConversationStore } from '@capix/conversation-service/persistence';

// Diagnostic preload only. The ordinary capacity suite does not import this file.
// CAPIX_CAPACITY_COST=/new/result.json node --import ./examples/capacity/diagnostics/cost.mjs ...
const destination = process.env.CAPIX_CAPACITY_COST;
if (!destination) throw new Error('Set CAPIX_CAPACITY_COST to a new diagnostic JSON file');
const checkpointStoreMode = process.env.CAPIX_CP_STORE ?? 'sqlite';
if (!['sqlite', 'memory'].includes(checkpointStoreMode)) throw new Error('CAPIX_CP_STORE must be sqlite or memory');
const descriptor = openSync(destination, 'wx', 0o600);
const began = performance.now();
const metrics = new Map();
const stack = [];
const slow = [];
const buckets = new Map();
const statements = new WeakMap();
const statementPrototypes = new WeakSet();
const storePrototypes = new WeakSet();
let slowDropped = 0;
let bucketsDropped = 0;
let outermostMs = 0;

function metric(name) {
  let value = metrics.get(name);
  if (!value) {
    value = { count: 0, failed: 0, totalMs: 0, selfMs: 0, maxMs: 0, inputBytes: 0, outputBytes: 0 };
    metrics.set(name, value);
  }
  return value;
}

/** Synchronous spans only. Never place an async lifetime on this nesting stack. */
function measure(name, work) {
  const scope = { name, started: performance.now(), childrenMs: 0 };
  const value = metric(name);
  stack.push(scope);
  try {
    return work();
  } catch (error) {
    value.failed++;
    throw error;
  } finally {
    const elapsed = performance.now() - scope.started;
    stack.pop();
    value.count++;
    value.totalMs += elapsed;
    value.selfMs += Math.max(0, elapsed - scope.childrenMs);
    value.maxMs = Math.max(value.maxMs, elapsed);
    if (stack.length) stack.at(-1).childrenMs += elapsed;
    else {
      outermostMs += elapsed;
      const atMs = Math.floor((scope.started - began) / 100) * 100;
      if (buckets.has(atMs) || buckets.size < 10_000) {
        const bucket = buckets.get(atMs) ?? { atMs, outermostMs: 0, count: 0, byCategory: {} };
        bucket.outermostMs += elapsed;
        bucket.count++;
        bucket.byCategory[name] = (bucket.byCategory[name] ?? 0) + elapsed;
        buckets.set(atMs, bucket);
      } else bucketsDropped++;
      if (elapsed >= 2) {
        if (slow.length < 5000) slow.push({ name, startMs: scope.started - began, elapsedMs: elapsed });
        else slowDropped++;
      }
    }
  }
}

function wrapMethod(target, method, name, after) {
  const original = Object.getOwnPropertyDescriptor(target, method);
  if (typeof original?.value !== 'function') throw new Error(`Diagnostic method unavailable: ${name}`);
  Object.defineProperty(target, method, {
    ...original,
    value: function (...args) {
      return measure(typeof name === 'function' ? name(this, args) : name, () => {
        const result = Reflect.apply(original.value, this, args);
        after?.(result, args);
        return result;
      });
    },
  });
}

const writer = Object.getOwnPropertyDescriptor(Invocation.prototype, 'checkpointWriter');
if (typeof writer?.get !== 'function') throw new Error('Diagnostic checkpoint writer unavailable');
Object.defineProperty(Invocation.prototype, 'checkpointWriter', {
  ...writer,
  get() {
    const endpoint = Reflect.apply(writer.get, this, []);
    if (!endpoint) return endpoint;
    return Object.freeze({ ...endpoint, save: (...args) => measure('cp.writer.save', () => Reflect.apply(endpoint.save, endpoint, args)) });
  },
});

function installStore(port, prefix) {
  const prototype = Object.getPrototypeOf(port);
  if (storePrototypes.has(prototype)) return;
  storePrototypes.add(prototype);
  for (const method of ['save', 'finish', 'read']) wrapMethod(prototype, method, `${prefix}.${method}`);
}

// Reach the host's port through its public factory, not a private module import.
wrapMethod(ConversationStore, 'open', 'host.store.open', (store) => {
  if (checkpointStoreMode === 'memory') {
    // Deliberate diagnostic counterfactual: keep content/interactions in SQLite,
    // but route the optional CP port to the ordinary in-process implementation.
    // This removes CP durability and is not an equivalent persisted service.
    const property = Object.getOwnPropertyDescriptor(store, 'checkpoints');
    if (!property || (!property.configurable && !property.writable)) throw new Error('Public checkpoint port cannot be replaced for this diagnostic');
    Object.defineProperty(store, 'checkpoints', { ...property, value: new MemoryCheckpointStore() });
  } else installStore(store.checkpoints, 'cp.sqlite');
});
for (const method of ['save', 'finish', 'read']) wrapMethod(MemoryCheckpointStore.prototype, method, `cp.memory.${method}`);

function size(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer ? value.byteLength : 0;
}

for (const method of ['brotliCompressSync', 'brotliDecompressSync']) {
  const name = method === 'brotliCompressSync' ? 'codec.brotli.compress' : 'codec.brotli.decompress';
  wrapMethod(zlib, method, name, (result, args) => {
    const value = metric(name);
    value.inputBytes += size(args[0]);
    value.outputBytes += size(result);
  });
}
// Built-in named ESM exports may already be imported by the host package.
syncBuiltinESMExports();

function sqlCategory(sql) {
  if (typeof sql !== 'string') return 'unknown';
  const verb = /^\s*(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|PRAGMA|CREATE|ALTER)/i.exec(sql)?.[1]?.toLowerCase() ?? 'other';
  if (['begin', 'commit', 'rollback', 'pragma'].includes(verb)) return verb;
  const area = /\bcheckpoint_(images|heads)\b/i.test(sql) ? 'checkpoint' : /\bcompletion_interactions\b/i.test(sql) ? 'interaction' : /\b(messages|memories|append_receipts|apply_receipts|content)\b/i.test(sql) ? 'content' : 'other';
  return `${area}.${verb}`;
}

wrapMethod(DatabaseSync.prototype, 'exec', (_database, args) => `sql.exec.${sqlCategory(args[0])}`);
wrapMethod(
  DatabaseSync.prototype,
  'prepare',
  (_database, args) => `sql.prepare.${sqlCategory(args[0])}`,
  (statement, args) => {
    statements.set(statement, sqlCategory(args[0]));
    const prototype = Object.getPrototypeOf(statement);
    if (statementPrototypes.has(prototype)) return;
    statementPrototypes.add(prototype);
    for (const method of ['run', 'get', 'all']) wrapMethod(prototype, method, (value) => `sql.${method}.${statements.get(value) ?? 'unknown'}`);
    // iterate() is lazy: timing its constructor would not time the SQL traversal.
  },
);

process.once('exit', () => {
  const report = {
    formatVersion: 1,
    timeOrigin: performance.timeOrigin,
    startedMs: began,
    elapsedMs: performance.now() - began,
    node: process.version,
    checkpointStoreMode,
    processId: process.pid,
    outermostMs,
    metrics: Object.fromEntries([...metrics].sort(([, a], [, b]) => b.selfMs - a.selfMs)),
    outermostBuckets100ms: [...buckets.values()],
    slowOutermostSpans: slow,
    slowDropped,
    bucketsDropped,
    limitations: [
      'Diagnostic-only synchronous wrappers alter timing; compare with an uninstrumented run.',
      'totalMs includes nested measured spans; selfMs removes those spans. Do not sum inclusive totals.',
      'cp.writer.save includes capture/checking/store and returned-head checking. cp.sqlite.save/finish include their own checking and transaction.',
      'InvocationCheckpoint is not exported. Finalization encoding and returned-head checking outside store.finish need a CPU profile.',
      'selfMs still includes all unwrapped descendants and diagnostic bookkeeping; it is not exclusive function CPU time.',
      'Buckets attribute the full outermost span to its start bucket; they are not CPU utilization windows.',
      'Store construction and closed-store inspection are included in SQL totals. SQL categories are fixed labels, never full SQL or bound parameters.',
      'SQL iterate traversal and JSON clone/validation functions are not directly instrumented.',
      'CAPIX_CP_STORE=memory is a counterfactual without durable CP; content and interactions still use the host SQLite store.',
    ],
  };
  try {
    writeFileSync(descriptor, JSON.stringify(report, null, 2));
  } finally {
    closeSync(descriptor);
  }
});
