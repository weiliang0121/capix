import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '@capix-observer/client-runtime';
import { deferred, transcriptSnapshot } from './fixtures.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
const configuration = (model = 'fixture') => ({ configured: true, model, contextBudget: 1000, maxOutputTokens: 100, timeoutMs: 1000 });
const message = (content) => ({ role: 'user', content });
const append = (revision, content) => ({ type: 'delta', event: { type: 'transcript', transcriptId: 'current', revision, occurredAt: '2026-10-09T00:00:00Z', change: { kind: 'messages-appended', start: revision - 1, messages: [message(content)] } } });

function createClient(config, observeTranscript) {
  return new ClientRuntime({
    conversation: { config, run: async () => assert.fail('initialization must not start business work') },
    transcripts: { transcript: async () => assert.fail('initialization uses an atomic stream baseline'), observeTranscript },
  });
}

test('failed configuration retains established entity synchronization and an explicit attempt can finish initialization', async () => {
  const firstConfig = deferred();
  const failure = new Error('configuration unavailable');
  let configCalls = 0;
  let connections = 0;
  let emit;
  const runtime = createClient(
    () => (++configCalls === 1 ? firstConfig.promise : Promise.resolve(configuration())),
    async (_id, accept, signal) => {
      connections++;
      emit = accept;
      accept({ type: 'baseline', snapshot: transcriptSnapshot([], 'current', 0) });
      await wait(signal);
    },
  );
  assert.deepEqual(runtime.getSnapshot().initialization, { status: 'idle' });
  const first = runtime.initialize();
  assert.equal(runtime.initialize(), first);
  await settle();
  assert.equal(runtime.getSnapshot().transcriptId, 'current');
  assert.equal(runtime.getSnapshot().initialization.status, 'running');
  const rejected = assert.rejects(first, (error) => error === failure);
  firstConfig.reject(failure);
  await rejected;
  assert.deepEqual(runtime.getSnapshot().initialization, { status: 'failed', attempt: 1, error: failure });
  emit(append(1, 'received after failed initialization'));
  assert.equal(runtime.getSnapshot().messages.length, 1);
  assert.equal(runtime.getSnapshot().transcripts.get('current').syncing, true);
  const second = runtime.initialize();
  assert.notEqual(second, first);
  assert.equal(runtime.initialize(), second);
  await second;
  assert.equal(configCalls, 2);
  assert.equal(connections, 1);
  assert.deepEqual(runtime.getSnapshot().initialization, { status: 'succeeded', attempt: 2 });
  assert.equal(runtime.getSnapshot().messages[0].content, 'received after failed initialization');
  assert.equal(runtime.getSnapshot().error, undefined);
  runtime.stopTranscript();
});

test('failed entity initialization retains configuration but does not make the client ready for submission', async () => {
  const firstEntity = deferred();
  const failure = new Error('entity access rejected');
  let configCalls = 0;
  let connections = 0;
  const runtime = createClient(
    async () => {
      configCalls++;
      return configuration();
    },
    async (_id, accept, signal) => {
      if (++connections === 1) return firstEntity.promise;
      accept({ type: 'baseline', snapshot: transcriptSnapshot([], 'current', 0) });
      await wait(signal);
    },
  );
  const first = runtime.initialize();
  await settle();
  assert.equal(runtime.getSnapshot().config.model, 'fixture');
  await assert.rejects(runtime.submit({ messages: [message('not ready')] }), /初始化/);
  const rejected = assert.rejects(first, (error) => error === failure);
  firstEntity.reject(failure);
  await rejected;
  assert.equal(runtime.getSnapshot().config.model, 'fixture');
  assert.equal(runtime.getSnapshot().initialization.status, 'failed');
  await runtime.initialize();
  assert.equal(configCalls, 1);
  assert.equal(connections, 2);
  assert.equal(runtime.getSnapshot().initialization.status, 'succeeded');
  runtime.stopTranscript();
});

test('late configuration from a failed attempt cannot overwrite a newer successful attempt', async () => {
  const oldConfig = deferred();
  const firstEntity = deferred();
  let configCalls = 0;
  let connections = 0;
  const runtime = createClient(
    () => (++configCalls === 1 ? oldConfig.promise : Promise.resolve(configuration('new'))),
    async (_id, accept, signal) => {
      if (++connections === 1) return firstEntity.promise;
      accept({ type: 'baseline', snapshot: transcriptSnapshot([message('new entity')], 'current', 1) });
      await wait(signal);
    },
  );
  const first = runtime.initialize();
  const rejected = assert.rejects(first, /first entity failed/);
  firstEntity.reject(new Error('first entity failed'));
  await rejected;
  await runtime.initialize();
  const current = runtime.getSnapshot();
  oldConfig.resolve(configuration('old'));
  await settle();
  assert.equal(runtime.getSnapshot(), current);
  assert.equal(runtime.getSnapshot().config.model, 'new');
  assert.equal(runtime.getSnapshot().messages[0].content, 'new entity');
  runtime.stopTranscript();
});

test('stopping current synchronization ends pending initialization and ignores its late configuration', async () => {
  const oldConfig = deferred();
  const streams = [];
  let configCalls = 0;
  const runtime = createClient(
    () => (++configCalls === 1 ? oldConfig.promise : Promise.resolve(configuration('new'))),
    async (_id, accept, signal) => {
      streams.push({ accept, signal });
      accept({ type: 'baseline', snapshot: transcriptSnapshot([message('preserved')], 'current', 1) });
      await wait(signal);
    },
  );
  const first = runtime.initialize();
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await settle();
  runtime.stopTranscript('current');
  await rejected;
  assert.deepEqual(runtime.getSnapshot().initialization, { status: 'stopped', attempt: 1 });
  assert.equal(runtime.getSnapshot().config, undefined);
  assert.equal(runtime.getSnapshot().messages[0].content, 'preserved');
  assert.equal(streams[0].signal.aborted, true);
  await runtime.initialize();
  const current = runtime.getSnapshot();
  oldConfig.resolve(configuration('old'));
  streams[0].accept(append(2, 'stale callback'));
  await settle();
  assert.equal(runtime.getSnapshot(), current);
  assert.equal(runtime.getSnapshot().config.model, 'new');
  assert.equal(streams.length, 2);
  runtime.stopTranscript();
});

test('stop before the first baseline preserves confirmed configuration and permits a fresh explicit attempt', async () => {
  const streams = [];
  let configCalls = 0;
  const runtime = createClient(
    async () => {
      configCalls++;
      return configuration();
    },
    async (_id, accept, signal) => {
      streams.push({ accept, signal });
      await wait(signal);
    },
  );
  const first = runtime.initialize();
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await settle();
  runtime.stopTranscript();
  await rejected;
  assert.equal(runtime.getSnapshot().config.model, 'fixture');
  const second = runtime.initialize();
  streams[0].accept({ type: 'baseline', snapshot: transcriptSnapshot([message('old')], 'old', 1) });
  streams[1].accept({ type: 'baseline', snapshot: transcriptSnapshot([], 'current', 0) });
  await second;
  assert.equal(configCalls, 1);
  assert.equal(runtime.getSnapshot().transcriptId, 'current');
  assert.equal(runtime.getSnapshot().transcripts.has('old'), false);
  runtime.stopTranscript();
});

test('an entity connection lost while configuration is pending cannot make initialization appear successful', async () => {
  const pendingConfig = deferred();
  const connection = deferred();
  const failure = new Error('entity disconnected');
  const runtime = createClient(
    () => pendingConfig.promise,
    async (_id, accept) => {
      accept({ type: 'baseline', snapshot: transcriptSnapshot([], 'current', 0) });
      return connection.promise;
    },
  );
  const first = runtime.initialize();
  await settle();
  connection.reject(failure);
  await settle();
  const rejected = assert.rejects(first, (error) => error === failure);
  pendingConfig.resolve(configuration());
  await rejected;
  assert.equal(runtime.getSnapshot().config.model, 'fixture');
  assert.equal(runtime.getSnapshot().initialization.status, 'failed');
  assert.equal(runtime.getSnapshot().transcripts.get('current').syncing, false);
});

test('stopping the default entity during its first baseline publication also invalidates pending configuration', async () => {
  const pendingConfig = deferred();
  const runtime = createClient(
    () => pendingConfig.promise,
    async (_id, accept, signal) => {
      accept({ type: 'baseline', snapshot: transcriptSnapshot([], 'current', 0) });
      if (!signal.aborted) await wait(signal);
    },
  );
  let notifications = 0;
  let stops = 0;
  runtime.subscribe(() => {
    notifications++;
    const state = runtime.getSnapshot();
    if (state.initialization.status === 'running' && state.initialization.attempt === 1 && state.transcripts.has('current')) {
      assert.doesNotThrow(() => runtime.stopTranscript('current'));
      stops++;
    }
  });
  await assert.rejects(runtime.initialize(), { name: 'AbortError' });
  assert.equal(runtime.getSnapshot().initialization.status, 'stopped');
  pendingConfig.resolve(configuration('stale'));
  await settle();
  assert.equal(runtime.getSnapshot().config, undefined);
  assert.equal(runtime.getSnapshot().transcripts.get('current').syncing, false);
  assert.equal(stops, 2, 'both nested stops complete without a duplicated attempt transition');
  const before = notifications;
  await runtime.initialize();
  assert.ok(notifications > before, 'the subscriber was not removed due to a reentrant stop error');
  runtime.stopTranscript();
});

test('a stopped-state subscriber can immediately start a new initialization without reusing the closing stream', async () => {
  const oldConfig = deferred();
  let configCalls = 0;
  const streams = [];
  const runtime = createClient(
    () => (++configCalls === 1 ? oldConfig.promise : Promise.resolve(configuration('new'))),
    async (_id, accept, signal) => {
      streams.push(signal);
      accept({ type: 'baseline', snapshot: transcriptSnapshot([], 'current', 0) });
      await wait(signal);
    },
  );
  let restarted;
  runtime.subscribe(() => {
    if (runtime.getSnapshot().initialization.status === 'stopped') restarted = runtime.initialize();
  });
  const first = runtime.initialize();
  const stopped = assert.rejects(first, { name: 'AbortError' });
  await settle();
  runtime.stopTranscript();
  await stopped;
  await restarted;
  assert.equal(streams.length, 2);
  assert.equal(streams[0].aborted, true);
  assert.equal(streams[1].aborted, false);
  assert.equal(runtime.getSnapshot().initialization.status, 'succeeded');
  assert.equal(runtime.getSnapshot().config.model, 'new');
  oldConfig.resolve(configuration('stale'));
  await settle();
  assert.equal(runtime.getSnapshot().config.model, 'new');
  runtime.stopTranscript();
});

test('a replaced first-baseline callback cannot merge away the new initialization stream', async () => {
  const oldConfig = deferred();
  let configCalls = 0;
  const streams = [];
  const runtime = createClient(
    () => (++configCalls === 1 ? oldConfig.promise : Promise.resolve(configuration('new'))),
    async (_id, accept, signal) => {
      streams.push(signal);
      accept({ type: 'baseline', snapshot: transcriptSnapshot([], 'current', 0) });
      if (!signal.aborted) await wait(signal);
    },
  );
  let restarted;
  runtime.subscribe(() => {
    const state = runtime.getSnapshot();
    if (state.initialization.status === 'running' && state.initialization.attempt === 1 && state.transcripts.has('current')) runtime.stopTranscript('current');
    else if (state.initialization.status === 'stopped') restarted = runtime.initialize();
  });
  await assert.rejects(runtime.initialize(), { name: 'AbortError' });
  await restarted;
  assert.equal(streams.length, 2);
  assert.equal(streams[0].aborted, true);
  assert.equal(streams[1].aborted, false);
  assert.equal(runtime.getSnapshot().transcripts.get('current').syncing, true);
  oldConfig.resolve(configuration('stale'));
  await settle();
  assert.equal(runtime.getSnapshot().config.model, 'new');
  runtime.stopTranscript();
});

test('an external stop and a synchronization subscriber can end the same pending attempt once', async () => {
  const pendingConfig = deferred();
  const runtime = createClient(
    () => pendingConfig.promise,
    async (_id, accept, signal) => {
      accept({ type: 'baseline', snapshot: transcriptSnapshot([], 'current', 0) });
      await wait(signal);
    },
  );
  const first = runtime.initialize();
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await settle();
  let nestedStops = 0;
  runtime.subscribe(() => {
    if (runtime.getSnapshot().initialization.status === 'running') {
      runtime.stopTranscript('current');
      nestedStops++;
    }
  });
  assert.doesNotThrow(() => runtime.stopTranscript('current'));
  await rejected;
  assert.equal(nestedStops, 1);
  assert.equal(runtime.getSnapshot().initialization.status, 'stopped');
  pendingConfig.resolve(configuration('stale'));
  await settle();
  assert.equal(runtime.getSnapshot().config, undefined);
});
