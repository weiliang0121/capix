import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineScene, CallableRecord, RecordingRootRecord, RuntimeCallRecord, bindRecording, Recorder, RecordBook, ExecutionRecord } from '@capix/server-runtime';
import { subscribeExecutions } from '@capix/observer-service';
import { createBoundRuntime, createRecordScope, observeCall } from '../fixtures/runtime.mjs';

const identity = { maxRounds: 1, execute: (context) => context.input };
const call = (runtime, work = identity) => runtime.executionInvocationBuilder.create('input', { context: {}, work });

test('record installation owns the long-lived result while BoundRuntime owns no record or call Context', () => {
  const recorder = new Recorder(new RecordBook());
  const recording = bindRecording(recorder);
  const capabilities = { observations: [recording] };
  const runtime = installCallable(defineScene()({ run: { execute: () => undefined } }), { providers: [], source: { capture: () => null }, ...capabilities });
  assert.equal(runtime.context, undefined);
  assert.equal(runtime.record, undefined);
  assert.equal(runtime.recorder, undefined);
  assert.ok(recording.root instanceof RecordingRootRecord);
  assert.equal(recording.root.status, undefined);
  assert.deepEqual(recording.root.childIds, []);
  assert.deepEqual(Object.keys(recording.root.value), ['createdAt']);
  assert.deepEqual([...recorder.book.values()], [recording.root]);
});

test('each BoundRuntime call owns its E while success and failure leave the shared instance open', async () => {
  const recorder = new Recorder(new RecordBook());
  const runtime = createBoundRuntime({ recorder });
  const original = runtime.record.toJSON();
  const first = call(runtime);
  await first.run();
  const failure = new Error('work failed');
  const second = call(runtime, {
    maxRounds: 1,
    execute: () => {
      throw failure;
    },
  });
  await assert.rejects(second.run(), (error) => error === failure);
  const third = call(runtime);
  await third.run();
  assert.deepEqual(original.childIds, []);
  const parents = [first, second, third].map((invocation) => recorder.book.get(invocation.record.parentId));
  assert.ok(parents.every((record) => record instanceof CallableRecord && record.structureKind === 'scene'));
  assert.deepEqual(
    runtime.record.childIds,
    parents.map((record) => record.id),
  );
  assert.deepEqual(
    parents.map((record) => record.status),
    ['succeeded', 'failed', 'succeeded'],
  );
  assert.deepEqual(
    [first, second, third].map((item) => item.record.status),
    ['succeeded', 'failed', 'succeeded'],
  );
  assert.equal(runtime.record.status, undefined);
  for (const invocation of [first, second, third]) {
    assert.equal(recorder.tree.root(invocation.record.id), runtime.record);
    for (const descendant of recorder.tree.descendants(invocation.record.id)) assert.equal(recorder.tree.root(descendant.id), runtime.record);
  }
});

test('shared Recorder ownership follows record links rather than Context lookup or Book scans', async (t) => {
  const recorder = new Recorder(new RecordBook());
  const first = createBoundRuntime({ recorder });
  const second = createBoundRuntime({ recorder });
  t.mock.method(recorder.book, 'values', () => assert.fail('full Book scan'));
  const seen = [];
  const unsubscribe = subscribeExecutions(first.recording, (snapshot) => seen.push(snapshot.execution.id));
  const a = call(first);
  const b = call(second);
  try {
    await a.run();
    await b.run();
    assert.ok(seen.length > 0);
    assert.ok(seen.every((id) => id === a.record.id));
    assert.throws(() => observeCall(first.recording, b), /does not exist/);
    assert.equal(observeCall(first.recording, a).execution.id, a.record.id);
  } finally {
    unsubscribe();
  }
});

test('execution requires its BoundRuntime call parent and failed registration leaves that parent intact', () => {
  class FailingBook extends RecordBook {
    reject = false;
    add(record) {
      const result = super.add(record);
      if (this.reject) throw new Error('registration failed');
      return result;
    }
  }
  const book = new FailingBook();
  const recorder = new Recorder(book);
  const parent = createRecordScope(recorder);
  const value = { input: {}, startedAt: recorder.clock.now() };
  assert.throws(() => recorder.add(new ExecutionRecord('context', value)), /Runtime call record parent/);
  assert.throws(() => recorder.add(new ExecutionRecord('context', value, parent.parentId)), /Runtime call record parent/);
  const record = new ExecutionRecord('context', value, parent.id);
  const previous = parent.childIds;
  book.reject = true;
  assert.throws(() => recorder.add(record), /registration failed/);
  assert.equal(parent.childIds, previous);
  assert.equal(book.get(record.id), undefined);
  book.reject = false;
  recorder.add(record);
  assert.deepEqual(parent.childIds, [...previous, record.id]);
});

test('BoundRuntime and its E remain usable without installing recording', async () => {
  const runtime = createBoundRuntime();
  assert.equal(runtime.record, undefined);
  assert.equal(runtime.context, undefined);
  const invocation = call(runtime);
  assert.equal(await invocation.run(), 'input');
  assert.equal(invocation.record, undefined);
});
