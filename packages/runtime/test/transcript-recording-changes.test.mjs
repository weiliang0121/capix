import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChangeBuffer, ChangeCaptureError } from '@weiliang0121/capix-changes';

import { Transcript } from '@weiliang0121/capix-transcript';

import { bindRecording } from '@weiliang0121/capix-runtime';

import { TranscriptRecord, RecordBook, Recorder } from '@weiliang0121/capix-records';

import { createBoundRuntime } from './fixtures/runtime.mjs';

const message = (content) => ({ role: 'user', content });

test('record registration failure does not undo an already captured transcript fact', () => {
  class RejectingBook extends RecordBook {
    add(record) {
      if (record instanceof TranscriptRecord) throw new Error('record unavailable');
      return super.add(record);
    }
  }
  const changes = new ChangeBuffer();
  const recording = bindRecording(new Recorder(new RejectingBook()), { failure: 'propagate' });
  const transcript = new Transcript([], { changes, observation: recording.transcript });
  assert.throws(
    () => transcript.append(message('committed')),
    (error) => error.code === 'OBSERVATION_FAILED' && error.cause.message === 'record unavailable',
  );
  assert.equal(transcript.length, 1);
  assert.equal(transcript.revision, 1);
  assert.equal(changes.take()[0].change.messages[0].content, 'committed');
});

test('capture failure reports committed facts and stops the local invocation instead of repeating work', async () => {
  const cause = new Error('capture unavailable');
  const recorder = new Recorder(new RecordBook());
  const changes = {
    capture: (event) => {
      if (event.type === 'transcript') throw cause;
    },
  };
  const runtime = createBoundRuntime({ recorder, changes });
  const transcript = new Transcript([], { observation: runtime.recording.transcript, changes });
  let calls = 0;
  let receives = 0;
  const invocation = runtime.executionInvocationBuilder.create('input', {
    context: { settings: {} },
    work: {
      maxRounds: 2,
      execute() {
        calls++;
        transcript.append(message('committed'));
      },
      accept(context) {
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
  assert.equal(transcript.length, 1);
  assert.equal(transcript.revision, 1);
  assert.equal([...recorder.book.values()].filter((record) => record instanceof TranscriptRecord).length, 1); // One outlet failure does not suppress the other consumer.
});

test('capturing and recording are separate outlets and capture runs after mutation', () => {
  const changes = new ChangeBuffer();
  const recorder = new Recorder(new RecordBook());
  const recording = bindRecording(recorder);
  let transcript;
  transcript = new Transcript([], {
    observation: recording.transcript,
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
  const records = [...recorder.book.values()].filter((record) => record instanceof TranscriptRecord);
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record instanceof TranscriptRecord));
});
