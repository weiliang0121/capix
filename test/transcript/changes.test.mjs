import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeObserver, ChangeCaptureError, Transcript, TranscriptRecord, RecordBook, Recorder, RecordingError, createRuntime } from '@capix-observer/runtime';

const message = (content) => ({ role: 'user', content });

test('a shared observer receives source-local revisions in capture order and transfers separate batches', () => {
  const changes = new ChangeObserver();
  const first = new Transcript([message('initial')], { changes });
  const second = createRuntime({ changes, messages: [message('other')] }).context.transcript;
  first.append(message('next'));
  first.startSegment(1);
  assert.equal(changes.size, 4);
  const batch = changes.take();
  assert.deepEqual(
    batch.map(({ transcriptId, revision, change }) => [transcriptId, revision, change.kind]),
    [
      [first.id, 1, 'messages-appended'],
      [second.id, 1, 'messages-appended'],
      [first.id, 2, 'messages-appended'],
      [first.id, 3, 'segment-started'],
    ],
  );
  assert.equal(changes.size, 0);
  assert.ok(Object.isFrozen(batch));
  second.append(message('later'));
  assert.equal(batch.length, 4);
  assert.equal(changes.take()[0].revision, 2);
  assert.deepEqual(changes.take(), []);
});

test('change facts freeze their accepted content and segment boundary without reloading live state', () => {
  const changes = new ChangeObserver();
  const transcript = new Transcript([], { changes });
  const input = [message('one'), message('two')];
  transcript.appendFrom(input);
  transcript.startSegment(1);
  const [append, segment] = changes.take();
  input[0].content = 'external mutation';
  input.push(message('extra'));
  transcript.append(message('three'));
  assert.equal(append.change.start, 0);
  assert.equal(append.change.messages.length, 2);
  assert.equal(append.change.messages[0], transcript.get(0));
  assert.equal(append.change.messages[0].content, 'one');
  assert.deepEqual(segment.change, { kind: 'segment-started', previousStart: 0, start: 1, end: 2 });
  for (const value of [append, append.change, append.change.messages, append.change.messages[0], segment, segment.change]) assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    append.change.messages[0].content = 'rewrite';
  }, TypeError);
  assert.ok(Number.isFinite(Date.parse(append.occurredAt)));
});

test('empty and rejected changes do not advance revision; unobserved transcripts still maintain local order', () => {
  for (const changes of [undefined, new ChangeObserver()]) {
    const transcript = new Transcript([], { changes });
    transcript.append();
    assert.throws(() => transcript.append(message('valid'), { role: 'invalid', content: 'bad' }), TypeError);
    assert.throws(() => transcript.startSegment(1), RangeError);
    assert.equal(transcript.length, 0);
    assert.equal(transcript.revision, 0);
    assert.equal(changes?.size ?? 0, 0);
    transcript.append(message('one'), message('two'));
    transcript.startSegment(1);
    assert.throws(() => transcript.startSegment(1), RangeError);
    assert.equal(transcript.revision, 2);
    assert.equal(changes?.size ?? 2, 2);
  }
});

test('record registration failure does not undo an already captured transcript fact', () => {
  class RejectingBook extends RecordBook {
    add() {
      throw new Error('record unavailable');
    }
  }
  const changes = new ChangeObserver();
  const transcript = new Transcript([], { changes, recorder: new Recorder(new RejectingBook()) });
  assert.throws(() => transcript.append(message('committed')), RecordingError);
  assert.equal(transcript.length, 1);
  assert.equal(transcript.revision, 1);
  assert.equal(changes.take()[0].change.messages[0].content, 'committed');
});

test('failed segment capture preserves the new boundary and later changes keep advancing', () => {
  const changes = new ChangeObserver();
  const transcript = new Transcript([message('one'), message('two')], {
    changes: {
      capture(event) {
        if (event.change.kind === 'segment-started') throw new Error('segment capture failed');
        changes.capture(event);
      },
    },
  });
  assert.throws(
    () => transcript.startSegment(1),
    (error) => {
      assert.ok(error instanceof ChangeCaptureError);
      assert.equal(error.event.revision, 2);
      assert.deepEqual(error.event.change, { kind: 'segment-started', previousStart: 0, start: 1, end: 2 });
      return true;
    },
  );
  assert.equal(transcript.activeStart, 1);
  assert.equal(transcript.revision, 2);
  transcript.append(message('three'));
  assert.deepEqual(
    changes.take().map((event) => event.revision),
    [1, 3],
  );
});

test('capture failure reports committed facts and stops the local invocation instead of repeating work', async () => {
  const cause = new Error('capture unavailable');
  const recorder = new Recorder(new RecordBook());
  const runtime = createRuntime({
    recorder,
    changes: {
      capture: (event) => {
        if (event.type === 'transcript') throw cause;
      },
    },
  });
  let calls = 0;
  let receives = 0;
  const invocation = runtime.executionInvocations.create('input', {
    context: { settings: {} },
    work: {
      maxRounds: 2,
      execute() {
        calls++;
        runtime.context.transcript.append(message('committed'));
      },
      receive(context) {
        receives++;
        return context.continueWith('retry', 'must not repeat the append');
      },
    },
  });
  await assert.rejects(invocation.run(), (error) => {
    assert.ok(error instanceof ChangeCaptureError);
    assert.equal(error.cause, cause);
    assert.equal(error.event.revision, 1);
    assert.equal(error.event.change.messages[0].content, 'committed');
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(receives, 0);
  assert.equal(runtime.context.transcript.length, 1);
  assert.equal(runtime.context.transcript.revision, 1);
  assert.equal([...recorder.book.values()].filter((record) => record instanceof TranscriptRecord).length, 0);
});

test('capturing and recording are separate outlets and capture runs after mutation', () => {
  const changes = new ChangeObserver();
  const recorder = new Recorder(new RecordBook());
  let transcript;
  transcript = new Transcript([], {
    recorder,
    changes: {
      capture(event) {
        assert.equal(transcript.revision, event.revision);
        assert.equal(transcript.length, 2);
        changes.capture(event);
      },
    },
  });
  const seen = [];
  recorder.subscribe(() => seen.push([changes.size, transcript.revision]));
  transcript.append(message('one'), message('two'));
  transcript.startSegment(1);
  assert.equal(changes.size, 2);
  assert.deepEqual(seen, [
    [1, 1],
    [2, 2],
  ]);
  const records = [...recorder.book.values()];
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record instanceof TranscriptRecord));
});
