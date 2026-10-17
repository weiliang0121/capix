import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { ChangeBuffer, assembleRuntime, RuntimeDefinition, ExecutionDefinition, invocationRecording, bindRecording, Recorder, RecordBook, BaseRecord, ExecutionRecordHelper, Transcript, Memories, ChangeCaptureError } from '@capix/server-runtime';
import { ObserverConversations, ObservationFeed, acceptConversationInput, createObserverServer } from '@capix/observer-service';
import { ObservationReplica, ObservationSequenceError, ClientRuntime } from '@capix/client-runtime';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix/client-http';
import { baseline, transport, conversationDescriptor, transcriptSnapshot } from '../client/fixtures.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 2048, timeoutMs: 1000 };
const raw = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const wire = (value) => JSON.parse(JSON.stringify(value));
const memoryChange = (content, id = null, indexes = [0]) => ({ action: id ? 'update' : 'create', memoryId: id, change: 'new evidence', sourceIndexes: indexes, result: { topic: 'topic', content, sourceIndexes: indexes } });

const environments = new WeakMap();
function fixture(messages = []) {
  let round = 0;
  let environment;
  const conversations = new ObserverConversations(
    {
      async invoke(request, purpose) {
        const input = JSON.parse(request.messages[1].content);
        if (purpose === 'selection') {
          round++;
          return raw({ historyIndexes: round > 1 ? input.history.slice(0, 2).map((entry) => entry.index) : [] });
        }
        if (purpose === 'answer') return round === 3 ? { ...raw({}), content: 'invalid model output' } : raw({ kind: 'answer', content: `answer ${round}` });
        const id = environment.memories.values()[0]?.id ?? null;
        return raw({ memories: [memoryChange(`memory ${round}`, id, [environment.transcript.length - 2, environment.transcript.length - 1])] });
      },
    },
    messages,
  );
  environment = conversations.open(conversations.list().defaultConversationId);
  environments.set(environment, conversations);
  return environment;
}
async function run(environment, content) {
  await environment.runtime.run({ messages: [{ role: 'user', content }] }, { settings });
}

function executionRuntime(execute, { changes, recording, accept, parentAccept } = {}) {
  class E extends ExecutionDefinition {
    observation = recording ? [invocationRecording()] : undefined;
    run = { requires: {}, execute, ...(accept ? { accept } : {}) };
  }
  const execution = new E();
  class R extends RuntimeDefinition {
    children = [execution];
    observation = recording ? [invocationRecording()] : undefined;
    run = {
      requires: {},
      execute: async (work) => {
        const child = work.children.create(execution, work.input, { key: 'test' });
        const output = await child.run();
        return child.accept(() => (parentAccept ? parentAccept(output) : output));
      },
    };
  }
  return assembleRuntime(new R(), { changes, observations: recording ? [recording] : [], providers: [], source: { entry: () => ({}), capture: () => ({}) } });
}

test('all live sources remain observable without Recorder and do not serialize arbitrary invocation IO', async () => {
  const changes = new ChangeBuffer();
  const transcript = new Transcript([{ role: 'user', content: 'evidence' }], { changes });
  const memories = new Memories(transcript, { changes });
  const opaque = new Map([['external', () => {}]]);
  const runtime = executionRuntime(
    () => {
      const [memory] = memories.apply([memoryChange('one')]);
      memories.apply([memoryChange('two', memory.id)]);
      transcript.append({ role: 'assistant', content: 'answer' });
      return opaque;
    },
    { changes },
  );
  assert.equal(await runtime.run(opaque, {}), opaque);
  const events = changes.take();
  assert.equal(
    events.some((event) => event.type === 'record'),
    false,
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'memory').map((event) => [event.sequence, event.change.action, event.change.result.content]),
    [
      [1, 'create', 'one'],
      [2, 'update', 'two'],
    ],
  );
  const calls = events.filter((event) => event.type === 'invocation' && event.level === 'execution');
  assert.equal(calls[0].change.kind, 'started');
  assert.deepEqual(
    calls.map((event) => event.sequence),
    calls.map((_, index) => index + 1),
  );
  assert.equal(calls.at(-1).change.status, 'succeeded');
  assert.ok(events.every(Object.isFrozen));
});

test('record registration captures its child and parent reference together; process deltas contain only the new entry', async () => {
  const changes = new ChangeBuffer();
  const recorder = new Recorder(new RecordBook(), { clock: undefined, changes });
  const recording = bindRecording(recorder);
  const runtime = executionRuntime(() => 'output', { recording, changes });
  const initial = changes.take()[0];
  await runtime.run('input', {});
  const events = changes.take().filter((event) => event.type === 'record');
  const added = events.find((event) => event.change.kind === 'added' && event.change.entry.kind === 'execution');
  const parent = events.find((event) => event.change.kind === 'added' && event.change.entry.kind === 'runtime-call');
  assert.deepEqual(added.change.parent, { id: parent.change.entry.data.id, childId: added.change.entry.data.id });
  assert.deepEqual(initial.change.entry.data.childIds, [], 'old parent snapshot remains fixed');
  assert.deepEqual(added.change.entry.data.value.processes, [], 'registration did not mutate into the final record');
  const process = events.filter((event) => event.change.kind === 'process-appended' && event.change.id === added.change.entry.data.id);
  assert.equal(process.length, 3);
  assert.ok(process.every((event) => !('entry' in event.change) && !('processes' in event.change)));
  assert.equal(events.find((event) => event.change.kind === 'finished' && event.change.id === added.change.entry.data.id).change.result.resultOf, 2);
  assert.deepEqual(
    events.map((event) => event.revision),
    events.map((_, index) => index + 2),
  );
});

test('multi-round observation deltas reconstruct records and content locations exactly; completed execution bodies stay out of reconnect baseline', async (t) => {
  const environment = fixture();
  const feed = new ObservationFeed(environment);
  const frames = [];
  let replica;
  let failure;
  feed.connect((frame) => {
    frames.push(frame);
    try {
      replica = ObservationReplica.receive(replica, frame);
    } catch (error) {
      failure = error;
    }
  });
  try {
    await run(environment, 'first');
    await run(environment, 'second');
    await assert.rejects(run(environment, 'third'));
    await run(environment, 'fourth');
    await settle();
    assert.equal(failure, undefined);
    assert.deepEqual(
      replica.overview.messages.map((entry) => entry.index),
      environment.transcript.snapshot().map((_, index) => index),
    );
    assert.equal(replica.memory.items.length, 1);
    assert.equal(replica.memory.items[0].content, 'memory 4');
    assert.equal(replica.memory.items[0].records.length, 3);
    assert.equal(replica.snapshots.size, 4);
    for (const [id, snapshot] of replica.snapshots) assert.deepEqual(snapshot, wire(ExecutionRecordHelper.snapshot(environment.recorder, id)));
    assert.ok(frames.slice(1).every((frame) => frame.type === 'delta' && !('snapshot' in frame)));
    assert.deepEqual(
      frames.map((frame) => frame.sequence),
      frames.map((_, index) => frames[0].sequence + index),
    );
    assert.equal(ObservationReplica.receive(replica, frames.at(-1)), replica, 'duplicate delivery is ignored');
    const materialized = [];
    const toJSON = BaseRecord.prototype.toJSON;
    t.mock.method(BaseRecord.prototype, 'toJSON', function () {
      materialized.push(this);
      return toJSON.call(this);
    });
    let baseline;
    const stop = feed.connect((frame) => {
      baseline ??= frame;
    });
    stop();
    assert.equal(baseline.overview.executions.length, 4);
    assert.equal(baseline.entries.filter((entry) => entry.kind === 'execution').length, 0);
    assert.equal(baseline.entries[0].kind, 'runtime');
    assert.equal(baseline.memory.items[0].content, 'memory 4');
    assert.deepEqual(
      materialized.filter((record) => record.kind !== 'memory').map((record) => record.id),
      [environment.recording.root.id],
      'opening must select current records before materializing historical bodies',
    );
  } finally {
    feed.close();
  }
});

test('receiver rejects gaps, foreign scopes and invalid batches without partially applying their facts', () => {
  const environment = fixture();
  const feed = new ObservationFeed(environment);
  let frame;
  feed.connect((value) => {
    frame ??= value;
  });
  const before = ObservationReplica.receive(undefined, frame);
  const append = { type: 'transcript', transcriptId: frame.transcript.id, revision: frame.transcript.revision + 1, occurredAt: new Date().toISOString(), change: { kind: 'messages-appended', start: 0, end: 1 } };
  const delta = { type: 'delta', scopeId: frame.scopeId, sequence: frame.sequence + 1, changes: [append] };
  try {
    assert.throws(() => ObservationReplica.receive(before, { ...delta, sequence: delta.sequence + 1 }), ObservationSequenceError);
    assert.throws(() => ObservationReplica.receive(before, { ...delta, scopeId: 'foreign' }), ObservationSequenceError);
    assert.throws(() => ObservationReplica.receive(before, { ...delta, changes: [append, append] }), ObservationSequenceError);
    assert.equal(before.overview.messages.length, 0);
    assert.equal(before.sequence, frame.sequence);
    const after = ObservationReplica.receive(before, delta);
    assert.equal(after.overview.messages.length, 1);
    assert.equal(ObservationReplica.receive(after, delta), after);
  } finally {
    feed.close();
  }
});

test('consumer exceptions are isolated and a pending initial append is represented once by the baseline', async () => {
  const environment = fixture([{ role: 'user', content: 'initial' }]);
  const feed = new ObservationFeed(environment);
  feed.connect(() => {
    throw new Error('consumer failed');
  });
  let replica;
  feed.connect((frame) => {
    replica = ObservationReplica.receive(replica, frame);
  });
  try {
    assert.equal(replica.overview.messages.length, 1);
    await run(environment, 'next');
    await settle();
    assert.equal(replica.overview.messages.length, 3);
    assert.equal(environment.transcript.length, 3);
  } finally {
    feed.close();
  }
});

test('memory capture failure preserves the whole committed batch and attempts publication of every fact', () => {
  const transcript = new Transcript([{ role: 'user', content: 'evidence' }]);
  const captured = [];
  const observed = [];
  const failure = new Error('capture failed');
  const memories = new Memories(transcript, {
    changes: {
      capture(event) {
        assert.equal(memories.sequence, 2);
        assert.equal(memories.values().length, 2);
        captured.push(event);
        throw failure;
      },
    },
    observation: {
      publish(event) {
        observed.push(event);
      },
    },
  });
  assert.throws(
    () => memories.apply([memoryChange('one'), memoryChange('two')]),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      for (const [index, fault] of error.errors.entries()) {
        assert.ok(fault instanceof ChangeCaptureError);
        assert.equal(fault.cause, failure);
        assert.equal(fault.event, captured[index]);
      }
      return true;
    },
  );
  assert.equal(memories.sequence, 2);
  assert.deepEqual(
    memories.values().map((memory) => memory.content),
    ['one', 'two'],
  );
  assert.deepEqual(
    captured.map((event) => event.sequence),
    [1, 2],
  );
  assert.deepEqual(observed, captured);
});

async function serve(t, observer) {
  const conversations = environments.get(observer);
  const server = createObserverServer({ conversations, settings, configured: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), 'state did not reach expected boundary');
}

test('real HTTP applies successive deltas, memory and failed rounds without per-change snapshot queries', async (t) => {
  const environment = fixture();
  const base = await serve(t, environment);
  const requests = [];
  const observed = new ObservationHttpTransport(base, (url, init) => {
    requests.push(new URL(url).pathname);
    return fetch(url, init);
  });
  const conversation = new ConversationHttpTransport(base);
  const runtime = new ClientRuntime({ conversation, transcripts: conversation, observation: observed });
  t.after(() => runtime.stopTranscript());
  const stop = runtime.startObservation();
  t.after(stop);
  await runtime.initialize();
  await until(() => !runtime.getSnapshot().observation.loading);
  for (const content of ['first', 'second', 'third', 'fourth']) {
    await runtime.submit({ messages: [{ role: 'user', content }] });
    assert.equal(runtime.getSnapshot().submission.remote.result.status, content === 'third' ? 'failed' : 'completed');
    assert.equal(runtime.getSnapshot().submission.feedback.status, 'ended', 'a remote failure is a confirmed outcome, not a broken connection');
  }
  await until(() => {
    const observation = runtime.getSnapshot().observation;
    assert.equal(observation.error, undefined);
    return observation.records.size === 4 && [...observation.records.values()].every((snapshot) => snapshot.execution.status !== 'running');
  });
  assert.equal(runtime.getSnapshot().observation.error, undefined);
  const failed = [...runtime.getSnapshot().observation.records.values()].find((snapshot) => snapshot.execution.status === 'failed');
  assert.equal(failed.execution.value.failure.kind, 'exception');
  const handling = failed.operations.find((operation) => operation.operation === 'answer').value.processes.filter((process) => process.stage === 'handling');
  assert.deepEqual(
    handling.map((process) => process.type),
    ['start', 'continue', 'start', 'unhandled'],
  );
  assert.ok(handling.filter((process) => 'failure' in process).every((process) => process.failure.kind === 'exception'));
  await until(() => runtime.getSnapshot().messages.length === 7);
  assert.equal(runtime.getSnapshot().observation.memory.items[0].content, 'memory 4');
  assert.deepEqual(requests, ['/api/observe']);
  const oldScope = runtime.getSnapshot().observation.cursor.scopeId;
  await runtime.refreshObservation();
  await until(() => !runtime.getSnapshot().observation.loading);
  assert.notEqual(runtime.getSnapshot().observation.cursor.scopeId, oldScope);
  assert.equal(runtime.getSnapshot().observation.cursor.sequence, 0, 'new connection has its own delivery order');
  assert.equal(runtime.getSnapshot().observation.overview.executions.length, 4);
  assert.equal(runtime.getSnapshot().observation.records.size, 0, 'finished details remain lazy after reconnect');
  const id = runtime.getSnapshot().observation.overview.executions[0].id;
  assert.equal((await runtime.loadExecution(id)).execution.status, 'succeeded');
});

test('large entity baseline preserves full message text while observation carries only locations', async (t) => {
  const content = '中文'.repeat(50000);
  const environment = fixture([{ role: 'user', content }]);
  const base = await serve(t, environment);
  const conversationId = environments.get(environment).list().defaultConversationId;
  const controller = new AbortController();
  t.after(() => controller.abort());
  let frame;
  await new ConversationHttpTransport(base)
    .observeTranscript(
      environment.transcript.id,
      (value) => {
        frame = value;
        controller.abort();
      },
      controller.signal,
    )
    .catch((error) => {
      if (!controller.signal.aborted) throw error;
    });
  assert.equal(frame.type, 'baseline');
  assert.equal(frame.snapshot.messages[0].content, content);
  const overview = await new ObservationHttpTransport(base).overview(conversationId);
  assert.equal('message' in overview.messages[0], false);
});

test('client performs one bounded baseline retry on a sequence gap and ignores the old session', async () => {
  const environment = fixture();
  const feed = new ObservationFeed(environment);
  let initial;
  feed.connect((frame) => {
    initial ??= frame;
  });
  feed.close();
  let connections = 0;
  let oldAccept;
  const io = transport({ activeSubmission: async () => ({ conversationId: 'fixture-conversation', transcriptId: initial.transcript.id }), conversations: async () => ({ conversations: [conversationDescriptor('fixture-conversation', initial.transcript.id)], defaultConversationId: 'fixture-conversation' }), transcript: async () => transcriptSnapshot([], initial.transcript.id) });
  const runtime = new ClientRuntime({
    conversation: io,
    transcripts: io,
    observation: {
      async observe(_conversationId, accept, signal) {
        connections++;
        accept(initial);
        if (connections === 1) {
          oldAccept = accept;
          accept({ type: 'delta', scopeId: initial.scopeId, sequence: initial.sequence + 2, changes: [] });
        }
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    },
  });
  await runtime.initialize();
  const stop = runtime.startObservation();
  try {
    await until(() => connections === 2 && !runtime.getSnapshot().observation.loading);
    const current = runtime.getSnapshot();
    oldAccept({ type: 'delta', scopeId: 'stale', sequence: 100, changes: [] });
    assert.equal(runtime.getSnapshot(), current);
    assert.equal(runtime.getSnapshot().observation.error, undefined);
  } finally {
    stop();
    runtime.stopTranscript();
  }
});

test('repeated sequence failure stops after one retry instead of looping forever', async () => {
  let connections = 0;
  const io = transport();
  const runtime = new ClientRuntime({
    conversation: io,
    transcripts: io,
    observation: {
      async observe(_conversationId, accept) {
        connections++;
        accept({ type: 'delta', scopeId: 'no-baseline', sequence: 1, changes: [] });
      },
    },
  });
  await runtime.initialize();
  const stop = runtime.startObservation();
  try {
    await until(() => Boolean(runtime.getSnapshot().observation.error));
    assert.equal(connections, 2);
    assert.equal(runtime.getSnapshot().observation.loading, false);
  } finally {
    stop();
    runtime.stopTranscript();
  }
});

test('joining during an active call seeds local source positions and continues through terminal deltas', async () => {
  const environment = fixture();
  const feed = new ObservationFeed(environment);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = executionRuntime(() => pending, { recording: environment.recording, changes: environment.changes });
  const running = runtime.run('input', {});
  await settle();
  const record = [...environment.book.values()].find((record) => record.kind === 'execution');
  let replica;
  let failure;
  const stop = feed.connect((frame) => {
    try {
      replica = ObservationReplica.receive(replica, frame);
    } catch (error) {
      failure = error;
    }
  });
  try {
    assert.equal(failure, undefined);
    assert.equal(replica.snapshots.get(record.id).execution.status, 'running');
    assert.ok(replica.invocationEvents.get(record.contextId).sequence > 1);
    release('output');
    await running;
    await settle();
    assert.equal(failure, undefined);
    assert.deepEqual(replica.snapshots.get(record.id), wire(ExecutionRecordHelper.snapshot(environment.recorder, record.id)));
    assert.equal(replica.invocationEvents.get(record.contextId).change.status, 'succeeded');
  } finally {
    release('output');
    await running;
    stop();
    feed.close();
  }
});

test('reconnecting while R accepts a completed E preserves the child and the parent receiving relation', async () => {
  const environment = fixture();
  const feed = new ObservationFeed(environment);
  let release;
  const accepted = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = executionRuntime(() => 'child output', { recording: environment.recording, changes: environment.changes, parentAccept: () => accepted });
  const pending = runtime.run('input', {});
  await settle();
  const execution = [...environment.book.values()].find((record) => record.kind === 'execution');
  let replica;
  let failure;
  const stop = feed.connect((frame) => {
    try {
      replica = ObservationReplica.receive(replica, frame);
    } catch (error) {
      failure = error;
    }
  });
  try {
    assert.equal(failure, undefined);
    const snapshot = replica.snapshots.get(execution.id);
    assert.equal(snapshot.execution.status, 'succeeded');
    assert.equal(snapshot.runtimeCall.status, 'running');
    assert.equal(snapshot.runtimeCall.value.relationChanges.at(-1).change.kind, 'receiving');
    assert.equal(snapshot.runtimeCall.value.relationChanges.at(-1).childId, execution.id);
    release('accepted output');
    assert.equal(await pending, 'accepted output');
    await settle();
    assert.equal(failure, undefined);
    assert.deepEqual(replica.snapshots.get(execution.id), wire(ExecutionRecordHelper.snapshot(environment.recorder, execution.id)));
    assert.equal(replica.snapshots.get(execution.id).runtimeCall.value.relationChanges.at(-1).change.kind, 'accepted');
  } finally {
    release('accepted output');
    await pending;
    stop();
    feed.close();
    environment.consumer.close();
  }
});

test('actual recording failure terminates HTTP observation, rejects later healthy queries, and leaves transcript synchronization intact', async (t) => {
  const environment = fixture();
  const base = await serve(t, environment);
  const transcript = new ConversationHttpTransport(base);
  const observation = new ObservationHttpTransport(base);
  const runtime = new ClientRuntime({ conversation: transcript, transcripts: transcript, observation });
  const stop = runtime.startObservation();
  t.after(() => {
    stop();
    runtime.stopTranscript();
    environment.consumer.close();
  });
  await runtime.initialize();
  await until(() => !runtime.getSnapshot().observation.loading);
  const original = environment.recorder.add.bind(environment.recorder);
  environment.recorder.add = (record) => {
    if (record.kind === 'transcript') throw new Error('record storage unavailable');
    return original(record);
  };
  environment.transcript.append({ role: 'user', content: 'a fact despite record failure' });
  await until(() => runtime.getSnapshot().observation.error?.code === 'SOURCE_INCOMPLETE');
  await until(() => runtime.getSnapshot().messages.length === 1);
  assert.equal(runtime.getSnapshot().messages[0].content, 'a fact despite record failure');
  const result = await fetch(`${base}/api/executions?conversationId=${runtime.getSnapshot().conversation.id}`);
  assert.equal(result.status, 500);
  assert.equal((await result.json()).code, 'SOURCE_INCOMPLETE');
  await assert.rejects(observation.overview(runtime.getSnapshot().conversation.id), (error) => error.code === 'SOURCE_INCOMPLETE');
  let nextBaseline = false;
  await assert.rejects(
    observation.observe(
      runtime.getSnapshot().conversation.id,
      () => {
        nextBaseline = true;
      },
      new AbortController().signal,
    ),
    (error) => error.code === 'SOURCE_INCOMPLETE',
  );
  assert.equal(nextBaseline, false);
  assert.equal((await transcript.transcript(environment.transcript.id)).messages.length, 1);
});

test('individual record changes retain partial R terminal facts until the separate R boundary arrives', async () => {
  const changes = new ChangeBuffer();
  const recorder = new Recorder(new RecordBook(), { changes });
  const recording = bindRecording(recorder);
  const initial = changes.take();
  let replica = ObservationReplica.receive(undefined, baseline({ recorder: { id: recorder.id, revision: recorder.revision }, entries: initial.filter((event) => event.type === 'record').map((event) => event.change.entry) }));
  const runtime = executionRuntime(() => 'output', { changes, recording });
  await runtime.run('input', {});
  const events = changes.take();
  let sequence = 0;
  let sawPendingBoundary = false;
  for (const event of events) {
    replica = ObservationReplica.receive(replica, { type: 'delta', scopeId: replica.scopeId, sequence: ++sequence, changes: [event] });
    if (event.type === 'record' && event.change.kind === 'finished' && replica.entries.get(event.change.id)?.kind === 'runtime-call') {
      sawPendingBoundary = true;
      assert.equal(replica.entries.get(event.change.id).data.status, 'succeeded');
      assert.equal(replica.snapshots.size, 0, 'raw R terminal is retained without publishing an incomplete execution view');
    }
  }
  assert.equal(sawPendingBoundary, true);
  assert.equal(replica.snapshots.size, 1);
  const snapshot = [...replica.snapshots.values()][0];
  assert.deepEqual(snapshot, wire(ExecutionRecordHelper.snapshot(recorder, snapshot.execution.id)));
});
