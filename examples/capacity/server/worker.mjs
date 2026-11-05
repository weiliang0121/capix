import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createConversationWebHost } from '@capix/conversation-service/web';
import { createYieldingFetch, loadConversationContent } from '@capix/conversation-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { MemoryViewSource } from '@capix/memory';
import { TranscriptViewSource } from '@capix/transcript';
import { ChatCompletionsProvider } from '@capix/model-provider';
import { measureStorage } from '../assembly.mjs';
import { measureProcess, modelMeter } from '../measurement.mjs';
import { expectedAnswer } from '../upstream-client.mjs';

// The current public Web host owns one conversation. Each experiment conversation
// gets a real, unchanged public host on its own loopback port; the load generator
// keeps this fixed mapping. This is not a production router or load balancer.
const sessions = [];
let state = 'new';
let configuration;
let directory;
let meter;
let measurement;
let closing;
let messages = Promise.resolve();

process.on('message', (message) => {
  messages = messages.then(() => dispatch(message)).catch(fail);
});
process.on('disconnect', () => {
  void shutdown()
    .catch(reportShutdownFailure)
    .finally(() => {
      if (state !== 'finished') process.exitCode = 1;
    });
});
process.on('SIGTERM', () => {
  process.exitCode = 1;
  void shutdown()
    .catch(reportShutdownFailure)
    .finally(() => {
      if (process.connected) process.disconnect();
    });
});

async function dispatch(message) {
  if (message?.kind === 'initialize') {
    if (state !== 'new') throw new Error('Worker was already initialized');
    state = 'initializing';
    const { config, workerIndex, endpoint } = message;
    if (config?.profile !== 'checkpoint') throw new Error('The public Web host capacity experiment requires checkpoint persistence');
    if (!Number.isSafeInteger(config.workers) || config.workers < 1 || config.workers > 16 || !Number.isSafeInteger(workerIndex) || workerIndex < 0 || workerIndex >= config.workers) throw new Error('Invalid worker assignment');
    if (!Number.isSafeInteger(config.users) || config.users < config.workers || config.users > 500) throw new Error('Invalid conversation count');
    if (!Number.isSafeInteger(config.historyBytes) || config.historyBytes < 0 || config.historyBytes > 1024 * 1024) throw new Error('Invalid history size');
    if (!Number.isSafeInteger(config.model?.outputBytes) || config.model.outputBytes < 128 || config.model.outputBytes > 64 * 1024) throw new Error('Invalid model output size');
    if (!['direct', 'yield'].includes(config.transport)) throw new Error('Invalid model transport');
    const upstream = new URL(endpoint);
    if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.username || upstream.password) throw new Error('Only an independent loopback model simulator is allowed');
    if (typeof message.directory !== 'string' || !message.directory) throw new Error('An experiment directory is required');
    configuration = config;
    directory = message.directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    meter = modelMeter(new ChatCompletionsProvider({ endpoint, apiKey: 'offline-capacity-fixture', model: 'capacity-model', timeoutMs: 60_000, ...(config.transport === 'yield' ? { fetch: createYieldingFetch() } : {}) }));
    for (let index = workerIndex; index < config.users; index += config.workers) {
      if (closing) throw new Error('Worker closed while initializing');
      const database = join(directory, `session-${index}.sqlite`);
      const identity = seed(database, index, config.historyBytes);
      const host = createConversationWebHost({ database, model: meter.model, mode: 'demo', modelName: 'capacity-model', recoveryConfiguration: 'capacity-http-material-conversation-v1' });
      const session = { index, database, host, identity };
      sessions.push(session);
      await listen(host.server);
      session.origin = `http://127.0.0.1:${host.server.address().port}`;
    }
    state = 'ready';
    await send({ kind: 'ready', pid: process.pid, sessions: sessions.map(({ index, origin, identity }) => ({ index, origin, conversationId: identity.transcriptId })) });
    return;
  }
  if (!Number.isSafeInteger(message?.id)) throw new Error('Worker commands need a request id');
  if (message.kind === 'start') {
    if (state !== 'ready') throw new Error('Worker can start exactly once after initialization');
    if (meter.calls.length || meter.active) throw new Error('Model work occurred before measurement');
    globalThis.gc?.();
    measurement = measureProcess();
    await delay(20);
    measurement.reset();
    state = 'running';
    await send({ kind: 'reply', id: message.id, value: {} });
    return;
  }
  if (message.kind === 'finish') {
    if (state !== 'running') throw new Error('Worker must be running before finish');
    state = 'finishing';
    // The controller drains all submitted HTTP requests first. Independently owned
    // senders may nevertheless still be finishing: account for that work too.
    const deadline = performance.now() + 65_000;
    while (meter.active > 0 && performance.now() < deadline) await delay(10);
    if (meter.active) throw new Error('Model senders did not settle before worker shutdown');
    const metrics = measurement.stop();
    measurement = undefined;
    await shutdown();
    const inspected = sessions.map(inspectClosedSession);
    const storage = measureStorage(directory);
    const value = { pid: process.pid, metrics, model: { calls: meter.calls, active: meter.active, peakActive: meter.peakActive }, sessions: inspected, storage };
    state = 'finished';
    await send({ kind: 'reply', id: message.id, value });
    if (process.connected) process.disconnect();
    return;
  }
  throw new Error('Unknown worker command');
}

function seed(database, index, historyBytes) {
  // Both seed and host use the public single-writer store, one at a time. Existing
  // files are never opened for a new experiment or silently overwritten.
  closeSync(openSync(database, 'wx', 0o600));
  const store = ConversationStore.open(database);
  try {
    const content = loadConversationContent(store);
    const marker = `session-${index}:private-history\n`;
    const history = marker + 'x'.repeat(Math.max(0, historyBytes - Buffer.byteLength(marker)));
    content.transcript.append({ role: 'user', content: history });
    const [memory] = content.memories.apply([{ action: 'create', memoryId: null, change: 'Seed one private capacity fixture fact', sourceIndexes: [0], result: { topic: 'capacity fixture', content: `session-${index}:private-memory`, sourceIndexes: [0] } }]);
    content.view.includeSync(
      { messages: new TranscriptViewSource(content.transcript), memories: new MemoryViewSource(content.memories) },
      [
        { source: 'messages', key: 0 },
        { source: 'memories', key: memory.id },
      ],
      store.view,
    );
    return { transcriptId: content.transcript.id, memoriesId: content.memories.id, memoryId: memory.id, history };
  } finally {
    store.close();
  }
}

function inspectClosedSession(session) {
  const errors = [];
  const result = { index: session.index, conversationId: session.identity.transcriptId, reloadVerified: false, answerIntegrity: false, errors };
  let store;
  try {
    store = ConversationStore.open(session.database);
    const content = loadConversationContent(store);
    const messages = content.transcript.snapshot();
    const memory = content.memories.values();
    const members = content.view.members();
    result.messages = messages.length;
    result.userMessages = messages.filter((message) => message.role === 'user').length;
    result.assistantMessages = messages.filter((message) => message.role === 'assistant').length;
    result.memories = memory.length;
    result.viewMembers = members.length;
    result.historyBytes = Buffer.byteLength(session.identity.history);
    result.pairs = [];
    result.reloadVerified = true;
    if (content.transcript.id !== session.identity.transcriptId || content.memories.id !== session.identity.memoriesId) errors.push('Content identities changed');
    if (messages[0]?.role !== 'user' || messages[0]?.content !== session.identity.history) errors.push('Private seed history changed');
    if (memory.length !== 1 || memory[0]?.id !== session.identity.memoryId || memory[0]?.content !== `session-${session.index}:private-memory`) errors.push('Private seed memory changed');
    const nonces = new Set();
    let previousTurn = 0;
    for (let position = 1; position < messages.length; position += 2) {
      const input = messages[position];
      const answer = messages[position + 1];
      if (input?.role !== 'user' || answer?.role !== 'assistant') {
        errors.push(`Incomplete formal message pair at ${position}`);
        continue;
      }
      let query;
      try {
        query = JSON.parse(input.content);
      } catch {
        errors.push(`Invalid submitted query at ${position}`);
        continue;
      }
      if (query === null || typeof query !== 'object' || query.session !== session.index || !Number.isSafeInteger(query.turn) || query.turn <= previousTurn || typeof query.nonce !== 'string' || !query.nonce || nonces.has(query.nonce)) errors.push(`Query ownership or sequence mismatch at ${position}`);
      else {
        previousTurn = query.turn;
        nonces.add(query.nonce);
      }
      if (answer.content !== expectedAnswer(input.content, configuration.model.outputBytes)) errors.push(`Formal answer differs from the exact request at ${position + 1}`);
      result.pairs.push({ inputIndex: position, answerIndex: position + 1, nonce: query?.nonce, turn: query?.turn });
    }
    // The selected policy includes every formal message and keeps the seed memory.
    // No empty model proposal is allowed to erase private content or change membership.
    const keys = new Set(members.map((member) => `${member.source}:${member.key}`));
    if (keys.size !== messages.length + 1 || messages.some((_, index) => !keys.has(`messages:${index}`)) || !keys.has(`memories:${session.identity.memoryId}`)) errors.push('View membership differs from the selected inclusion policy');
    result.answerIntegrity = errors.length === 0;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      store?.close();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      result.answerIntegrity = false;
    }
  }
  return result;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', failed);
      resolve();
    });
  });
}

function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected) {
      reject(new Error('Capacity worker controller disconnected'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

function shutdown() {
  closing ??= (async () => {
    measurement?.stop();
    measurement = undefined;
    const results = await Promise.allSettled(sessions.map((session) => session.host.close()));
    const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, 'Capacity worker shutdown failed');
  })();
  return closing;
}

async function fail(error) {
  process.exitCode = 1;
  const diagnostic = { kind: 'error', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
  if (process.connected) await send(diagnostic).catch(() => undefined);
  else process.stderr.write(`${diagnostic.message}\n`);
  await shutdown().catch((failure) => process.stderr.write(`Shutdown: ${failure.message}\n`));
  if (process.connected) process.disconnect();
}

function reportShutdownFailure(error) {
  process.exitCode = 1;
  process.stderr.write(`Shutdown: ${error instanceof Error ? error.message : String(error)}\n`);
}
