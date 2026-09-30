import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime, RuntimeContext, RuntimeRecord, RuntimeRecordHelper, Recorder, RecordBook, ExecutionRecord, ExecutionRecordHelper, createRuntime } from '@capix-observer/runtime';
import { subscribeExecutions } from '@capix-observer/service';

const identity = { maxRounds: 1, execute: (context) => context.input };
const call = (runtime, work = identity) => runtime.executionInvocations.create('input', { context: { settings: {} }, work: work });

test('Runtime construction retains an established context and record without registering a new scope', () => {
  const recorder = new Recorder(new RecordBook());
  const original = createRuntime({ recorder, messages: [{ role: 'user', content: 'hello' }] });
  const before = [...recorder.book.values()];
  const runtime = new Runtime(original.context, { recording: { recorder, record: original.record } });
  assert.ok(runtime.context instanceof RuntimeContext);
  assert.equal(runtime.context, original.context);
  assert.equal(runtime.context.transcript.get(0).content, 'hello');
  assert.equal(runtime.record, original.record);
  assert.deepEqual([...recorder.book.values()], before);
  assert.deepEqual(Object.keys(runtime.record.value), ['createdAt']);
  assert.equal(runtime.record.status, undefined);
  assert.deepEqual(runtime.record.childIds, []);
  const otherRecorder = new Recorder(new RecordBook());
  assert.throws(() => new Runtime(runtime.context, { recording: { recorder: otherRecorder, record: runtime.record } }), /not registered/);
  const unregistered = new RuntimeRecord({ createdAt: recorder.clock.now() });
  assert.throws(() => new Runtime(runtime.context, { recording: { recorder, record: unregistered } }), /not registered/);
});

test('success and failure finish individual executions while the Runtime record retains their direct ownership', async () => {
  const recorder = new Recorder(new RecordBook());
  const runtime = createRuntime({ recorder });
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
  assert.deepEqual(runtime.record.childIds, [first.record.id, second.record.id, third.record.id]);
  assert.deepEqual(
    [first, second, third].map((item) => item.record.status),
    ['succeeded', 'failed', 'succeeded'],
  );
  assert.equal(runtime.record.status, undefined);
  assert.deepEqual(Object.keys(runtime.record.value), ['createdAt']);
  for (const item of [first, second, third]) {
    assert.equal(item.record.parentId, runtime.record.id);
    for (const descendant of recorder.tree.descendants(item.record.id)) assert.equal(recorder.tree.root(descendant.id), runtime.record);
  }
});

test('shared Recorder observation resolves Runtime ownership through record links without Context lookup or Book scans', async (t) => {
  const recorder = new Recorder(new RecordBook());
  const first = createRuntime({ recorder });
  const second = createRuntime({ recorder });
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
    assert.throws(() => ExecutionRecordHelper.observe(first.recording, b), /does not exist/);
    assert.equal(ExecutionRecordHelper.observe(first.recording, a).execution.id, a.record.id);
  } finally {
    unsubscribe();
  }
});

test('execution registration requires a Runtime parent and failed registration leaves that parent intact', () => {
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
  const root = RuntimeRecordHelper.create(recorder);
  const value = { input: {}, settings: {}, startedAt: recorder.clock.now() };
  assert.throws(() => recorder.add(new ExecutionRecord('context', value)), /Runtime parent/);
  const record = new ExecutionRecord('context', value, root.id);
  const previous = root.childIds;
  book.reject = true;
  assert.throws(() => recorder.add(record), /registration failed/);
  assert.equal(root.childIds, previous);
  assert.equal(book.get(record.id), undefined);
  book.reject = false;
  recorder.add(record);
  assert.deepEqual(root.childIds, [record.id]);
  assert.throws(() => recorder.add(new ExecutionRecord('other', value, record.id)), /Runtime parent/);
});

test('Runtime context and execution remain usable without recording', async () => {
  const runtime = createRuntime({ messages: [{ role: 'user', content: 'hello' }] });
  assert.ok(runtime.context instanceof RuntimeContext);
  assert.equal(runtime.record, undefined);
  assert.equal(runtime.recorder, undefined);
  assert.equal(runtime.context.transcript.length, 1);
  assert.equal(await call(runtime).run(), 'input');
});
