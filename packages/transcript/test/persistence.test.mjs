import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChangeBuffer, ProgressChannel } from '@weiliang0121/capix-changes';

import { PersistenceError } from '@weiliang0121/capix-diagnostics';

import { Transcript } from '@weiliang0121/capix-transcript';

const message = (content, role = 'user') => ({ role, content });

test('transcript restores identity, segments and revision silently, then persists before publishing the next fact', () => {
  const original = new Transcript([message('first'), message('answer', 'assistant')]);
  original.append(message('next'));
  original.startSegment(2);
  const saved = JSON.parse(JSON.stringify(original.exportState()));
  const changes = new ChangeBuffer();
  const writes = [];
  const order = [];
  let restored;
  restored = Transcript.restore(saved, {
    persistence: {
      commit(write) {
        assert.equal(restored.revision, write.expectedRevision);
        assert.equal(restored.length, 3);
        assert.ok(Object.isFrozen(write));
        writes.push(write);
        order.push('commit');
      },
    },
    changes: {
      capture(event) {
        assert.equal(restored.revision, event.revision);
        order.push('capture');
        changes.capture(event);
      },
    },
  });
  assert.equal(writes.length, 0);
  assert.equal(changes.size, 0);
  assert.deepEqual(restored.exportState(), original.exportState());
  assert.deepEqual(
    restored.segments().map((range) => [range.start, range.end]),
    [
      [0, 2],
      [2, 3],
    ],
  );
  saved.messages[0].content = 'external edit';
  saved.starts.push(3);
  const progress = new ProgressChannel({
    receive() {
      order.push('progress');
    },
  });
  restored.appendFrom([message('answer two', 'assistant')], { progress });
  assert.deepEqual(order, ['commit', 'progress', 'capture']);
  assert.equal(restored.get(0).content, 'first');
  assert.equal(restored.id, original.id);
  assert.equal(restored.revision, 4);
  assert.deepEqual(writes[0], { kind: 'append', transcriptId: original.id, expectedRevision: 3, revision: 4, start: 3, messages: [message('answer two', 'assistant')] });
});

test('transcript commit failures leave content, segments, progress and changes untouched', () => {
  const initial = new Transcript([message('first'), message('second')]).exportState();
  const failure = new Error('storage unavailable');
  const changes = new ChangeBuffer();
  const progress = [];
  const transcript = Transcript.restore(initial, {
    changes,
    persistence: {
      commit() {
        throw failure;
      },
    },
  });
  assert.throws(
    () =>
      transcript.appendFrom([message('third')], {
        progress: new ProgressChannel({
          receive(fact) {
            progress.push(fact);
          },
        }),
      }),
    (error) => error instanceof PersistenceError && error.operation === 'transcript.commit' && error.cause === failure,
  );
  assert.throws(
    () => transcript.startSegment(1),
    (error) => error instanceof PersistenceError && error.operation === 'transcript.commit' && error.cause === failure,
  );
  assert.deepEqual(transcript.exportState(), initial);
  assert.equal(changes.size, 0);
  assert.deepEqual(progress, []);
});

test('transcript persistence cannot reenter mutation and no-op or rejected input never commits', () => {
  const writes = [];
  let transcript;
  transcript = new Transcript([], {
    persistence: {
      commit(change) {
        assert.throws(() => transcript.append(message('reentry')), /reenter/);
        assert.throws(() => transcript.startSegment(1), /reenter/);
        writes.push(change);
      },
    },
  });
  transcript.append();
  assert.throws(() => transcript.append(message('one'), { role: 'bad', content: 'invalid' }));
  assert.equal(writes.length, 0);
  transcript.append(message('one'), message('two'));
  transcript.startSegment(1);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], { kind: 'start-segment', transcriptId: transcript.id, expectedRevision: 1, revision: 2, start: 1 });
});
