import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeRecorder, RuntimeRecord, RecordBook, RecordIndex, Runtime, Execution, TranscriptRecord, MemoryRecord, ExecutionRecordHelper } from '@capix-observer/runtime';
import { subscribeExecutions } from '@capix-observer/service';
import { validateSnapshot } from '@capix-observer/protocol';

class CustomRecord extends RuntimeRecord {
  revise(value) {
    this.replaceValue(value);
  }
}

test('Recorder accepts an unrelated record kind, updates only its own instance and isolates subscriber failures', (t) => {
  const recorder = new RuntimeRecorder(new RecordBook());
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

test('Recorder undoes registration indexes on index or Book failure and does not publish a failed write', () => {
  class RejectBook extends RecordBook {
    add() {
      throw new Error('book rejected');
    }
  }
  for (const rejectIndex of [true, false]) {
    const book = rejectIndex ? new RecordBook() : new RejectBook();
    const recorder = new RuntimeRecorder(book);
    const first = new RecordIndex(() => 'key');
    const second = new RecordIndex(() => {
      if (rejectIndex) throw new Error('index rejected');
      return 'key';
    });
    const record = new CustomRecord(null);
    let notifications = 0;
    recorder.subscribe(() => notifications++);
    assert.throws(
      () => recorder.add(record, [first, second]),
      (error) => error.code === 'RECORDING_FAILED',
    );
    assert.equal(book.get(record.id), undefined);
    assert.deepEqual(first.get('key'), []);
    assert.deepEqual(second.get('key'), []);
    assert.equal(notifications, 0);
  }
});

test('content notifications are visible to generic subscribers without manufacturing execution snapshots', () => {
  const recorder = new RuntimeRecorder(new RecordBook());
  const runtime = new Runtime({ recorder });
  const changes = [];
  const snapshots = [];
  recorder.subscribe((record) => changes.push(record));
  const unsubscribe = subscribeExecutions(runtime.recording, (snapshot) => snapshots.push(snapshot));
  runtime.transcript.append({ role: 'user', content: '北京' });
  runtime.memories.apply([{ action: 'create', memoryId: null, change: '确认城市', sourceIndexes: [0], result: { topic: '地点', content: '北京', sourceIndexes: [0] } }]);
  assert.equal(changes.length, 2);
  assert.ok(changes[0] instanceof TranscriptRecord);
  assert.ok(changes[1] instanceof MemoryRecord);
  assert.equal(changes[1].callId, undefined);
  assert.deepEqual(snapshots, []);
  unsubscribe();
});

test('Observer projects only its own call scope even when two Runtimes share one Recorder', async () => {
  const recorder = new RuntimeRecorder(new RecordBook());
  const a = new Runtime({ recorder });
  const b = new Runtime({ recorder });
  const views = [];
  const unsubscribe = subscribeExecutions(a.recording, (snapshot) => {
    validateSnapshot(snapshot);
    views.push(snapshot);
  });
  class Echo extends Execution {
    execute(context) {
      return context.input;
    }
  }
  let first;
  let other;
  await new Echo(a).call('one', { settings: {} }, (context) => {
    first = context;
  });
  const count = views.length;
  await new Echo(b).call('two', { settings: {} }, (context) => {
    other = context;
  });
  assert.ok(count > 0);
  assert.equal(views.length, count);
  assert.equal(views.at(-1).execution.status, 'succeeded');
  assert.throws(() => a.recording.get(other.id));
  const source = a.recording.source(first);
  assert.equal(source.callId, ExecutionRecordHelper.observe(a.recording, first).execution.id);
  a.transcript.appendFrom([{ role: 'assistant', content: '已完成' }], source);
  const appended = [...recorder.book.values()].at(-1);
  assert.equal(appended.callId, source.callId);
  assert.equal(appended.executionId, source.executionId);
  unsubscribe();
});
