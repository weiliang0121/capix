import { ExecutionFixture } from './fixtures/behavior.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Recorder, BaseRecord, RecordBook, TranscriptRecord, MemoryRecord, ExecutionRecordHelper, Transcript, Memories } from '@capix/server-runtime';
import { createBoundRuntime, observeCall, fixtureState } from './fixtures/runtime.mjs';
import { subscribeExecutions } from '@capix/observer-service';
import { validateExecutionRecordSnapshot } from '@capix/protocol';

class CustomRecord extends BaseRecord {
  revise(value) {
    this.replaceValue(value);
  }
}

test('Recorder accepts an unrelated record kind, updates only its own instance and isolates subscriber failures', (t) => {
  const recorder = new Recorder(new RecordBook());
  const received = [];
  const errors = [];
  t.mock.method(console, 'error', (message) => errors.push(message));
  const stopFailure = recorder.subscribe(() => {
    throw new Error('subscriber failed');
  });
  const stop = recorder.subscribe((record, change) => received.push([record.id, change, record.value]));
  const record = recorder.add(new CustomRecord('before'));
  recorder.update(record, (record) => record.revise('after'));
  assert.deepEqual(received, [
    [record.id, 'add', 'before'],
    [record.id, 'update', 'after'],
  ]);
  assert.equal(errors.length, 2);
  const foreign = new CustomRecord('foreign');
  let applied = false;
  assert.throws(
    () =>
      recorder.update(foreign, () => {
        applied = true;
      }),
    (error) => error.code === 'RECORDING_FAILED',
  );
  assert.equal(applied, false);
  assert.throws(
    () => recorder.add(record),
    (error) => error.code === 'RECORDING_FAILED',
  );
  assert.equal(received.length, 2);
  stopFailure();
  stop();
  recorder.update(record, (record) => record.revise('final'));
  assert.equal(received.length, 2);
  assert.equal(record.value, 'final');
});

test('content notifications are visible to generic subscribers without manufacturing execution snapshots', () => {
  const recorder = new Recorder(new RecordBook());
  const runtime = createBoundRuntime({ recorder });
  const changes = [];
  const snapshots = [];
  recorder.subscribe((record) => changes.push(record));
  const unsubscribe = subscribeExecutions(runtime.recording, (snapshot) => snapshots.push(snapshot));
  const transcript = new Transcript([], { observation: runtime.recording.transcript });
  const memories = new Memories(transcript, { observation: runtime.recording.memory });
  transcript.append({ role: 'user', content: '北京' });
  memories.apply([{ action: 'create', memoryId: null, change: '确认城市', sourceIndexes: [0], result: { topic: '地点', content: '北京', sourceIndexes: [0] } }]);
  assert.equal(changes.length, 2);
  assert.ok(changes[0] instanceof TranscriptRecord);
  assert.ok(changes[1] instanceof MemoryRecord);
  assert.equal(changes[1].callId, undefined);
  assert.deepEqual(snapshots, []);
  unsubscribe();
});

test('Observer projects only its own call scope even when two Runtimes share one Recorder', async () => {
  const recorder = new Recorder(new RecordBook());
  const a = createBoundRuntime({ recorder });
  const b = createBoundRuntime({ recorder });
  const views = [];
  const unsubscribe = subscribeExecutions(a.recording, (snapshot) => {
    validateExecutionRecordSnapshot(snapshot);
    views.push(snapshot);
  });
  class Echo extends ExecutionFixture {
    execute(context) {
      return context.input;
    }
  }
  let first;
  let other;
  await new Echo(a.executionInvocationBuilder).call('one', { settings: {} }, (context, invocation) => {
    first = invocation;
  });
  const count = views.length;
  await new Echo(b.executionInvocationBuilder).call('two', { settings: {} }, (context, invocation) => {
    other = invocation;
  });
  assert.ok(count > 0);
  assert.equal(views.length, count);
  assert.equal(views.at(-1).execution.status, 'succeeded');
  assert.throws(() => observeCall(a.recording, other), /does not exist/);
  const scope = fixtureState(a).invocationRecordings.get(first.context.id);
  new Transcript().appendFrom([{ role: 'assistant', content: '已完成' }], {
    origin: first.origin,
    observation: {
      publish: (event) => {
        scope.transcript(event);
      },
    },
  });
  const appended = [...recorder.book.values()].at(-1);
  assert.equal(appended.callId, first.record.id);
  assert.equal(appended.executionId, first.record.id);
  unsubscribe();
});
