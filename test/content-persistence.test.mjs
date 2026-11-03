import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeBuffer, ProgressChannel } from '@capix/changes';
import { PersistenceError } from '@capix/diagnostics';
import { Memories } from '@capix/memory';
import { Transcript } from '@capix/transcript';

const message = (content, role = 'user') => ({ role, content });
const create = (content, indexes = [0]) => ({ action: 'create', memoryId: null, change: 'new understanding', sourceIndexes: indexes, result: { topic: 'topic', content, sourceIndexes: indexes } });
const update = (memory, content) => ({ ...create(content), action: 'update', memoryId: memory.id });

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

test('memory restoration preserves order, identity and receipt sources without creating changes', () => {
  const transcript = new Transcript([message('input'), message('answer', 'assistant')]);
  const memories = new Memories(transcript);
  const source = { id: 'file-result', kind: 'file-created', answerIndex: 1, receipt: { path: 'notes.md', bytes: 7, digest: 'a'.repeat(64) } };
  const first = create('saved result');
  first.sourceResults = [source];
  first.result.sourceResults = [source];
  const [one, two] = memories.apply([first, create('other')]);
  memories.apply([update(two, 'updated')]);
  const snapshot = JSON.parse(JSON.stringify(memories.exportState()));
  const restoredTranscript = Transcript.restore(transcript.exportState());
  const changes = new ChangeBuffer();
  const writes = [];
  const restored = Memories.restore(snapshot, restoredTranscript, {
    changes,
    persistence: {
      commit(write) {
        writes.push(write);
      },
    },
  });
  assert.equal(writes.length, 0);
  assert.equal(changes.size, 0);
  assert.deepEqual(restored.exportState(), memories.exportState());
  assert.deepEqual(
    restored.values().map((memory) => memory.id),
    [one.id, two.id],
  );
  assert.equal(restored.get(one.id).transcript, restoredTranscript);
  snapshot.items[0].sourceResults[0].receipt.path = 'tampered';
  assert.equal(restored.get(one.id).sourceResults[0].receipt.path, 'notes.md');
  const stable = restored.get(two.id);
  restored.apply([update(stable, 'again')]);
  assert.equal(restored.get(two.id), stable);
  assert.equal(restored.sequence, 4);
  assert.equal(writes[0].expectedSequence, 3);
  assert.equal(writes[0].sequence, 4);
});

test('memory batch commits once before any state is changed, including updates and new identities', () => {
  const transcript = new Transcript([message('input')]);
  const original = new Memories(transcript);
  const [existing] = original.apply([create('before')]);
  const writes = [];
  const events = [];
  let memories;
  memories = Memories.restore(original.exportState(), transcript, {
    persistence: {
      commit(write) {
        assert.equal(memories.sequence, 1);
        assert.equal(memories.values().length, 1);
        assert.equal(memories.get(existing.id).content, 'before');
        assert.throws(() => memories.apply([create('reentry')]), /reenter/);
        for (const row of write.upserts) assert.ok(Object.isFrozen(row));
        writes.push(write);
      },
    },
    changes: {
      capture(event) {
        assert.equal(memories.sequence, 3);
        assert.equal(memories.values().length, 2);
        assert.equal(memories.get(existing.id).content, 'after');
        events.push(event);
      },
    },
  });
  const [updated, added] = memories.apply([update(existing, 'after'), create('new')]);
  assert.equal(updated.id, existing.id);
  assert.equal(writes.length, 1);
  assert.deepEqual(
    writes[0].upserts.map((item) => item.id),
    [updated.id, added.id],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [2, 3],
  );
});

test('failed memory batch commit applies nothing and does not reserve sequence or identity', () => {
  const transcript = new Transcript([message('input')]);
  const original = new Memories(transcript);
  const [existing] = original.apply([create('before')]);
  const snapshot = original.exportState();
  const changes = new ChangeBuffer();
  const failure = new Error('disk full');
  let failed = true;
  let commits = 0;
  const memories = Memories.restore(snapshot, transcript, {
    changes,
    persistence: {
      commit() {
        commits++;
        if (failed) throw failure;
      },
    },
  });
  assert.throws(
    () => memories.apply([update(existing, 'after'), create('new')]),
    (error) => error instanceof PersistenceError && error.operation === 'memories.commit' && error.cause === failure,
  );
  assert.deepEqual(memories.exportState(), snapshot);
  assert.equal(changes.size, 0);
  assert.deepEqual(memories.apply([update(existing, 'before')]), []);
  assert.equal(commits, 1);
  assert.throws(() => memories.apply([create('valid'), update({ id: 'missing' }, 'bad')]), /does not exist/);
  assert.equal(commits, 1);
  failed = false;
  memories.apply([update(existing, 'after'), create('new')]);
  assert.equal(memories.sequence, 3);
});

test('one memory publication failure does not hide other members of an already committed batch', () => {
  const transcript = new Transcript([message('input')]);
  const events = [];
  const observed = [];
  const writes = [];
  const memories = new Memories(transcript, {
    persistence: {
      commit(write) {
        writes.push(write);
      },
    },
    changes: {
      capture(event) {
        events.push(event.sequence);
        throw new Error(`capture ${event.sequence}`);
      },
    },
    observation: {
      publish(event) {
        observed.push(event.sequence);
      },
    },
  });
  assert.throws(() => memories.apply([create('one'), create('two')]), AggregateError);
  assert.equal(writes.length, 1);
  assert.equal(memories.sequence, 2);
  assert.equal(memories.values().length, 2);
  assert.deepEqual(events, [1, 2]);
  assert.deepEqual(observed, [1, 2]);
});

test('restoration rejects broken identities, positions and sources without submitting persistence writes', () => {
  const transcript = new Transcript([message('input'), message('answer', 'assistant')]);
  const base = transcript.exportState();
  let writes = 0;
  const persistence = {
    commit() {
      writes++;
    },
  };
  for (const state of [
    { ...base, id: '' },
    { ...base, starts: [] },
    { ...base, starts: [1] },
    { ...base, starts: [0, 0] },
    { ...base, starts: [0, 2] },
    { ...base, revision: 0 },
    { ...base, revision: 3 },
    { ...base, messages: [message('good'), undefined] },
  ])
    assert.throws(() => Transcript.restore(state, { persistence }));
  const memories = new Memories(transcript);
  const [memory] = memories.apply([create('understanding')]);
  const saved = memories.exportState();
  for (const state of [
    { ...saved, id: '' },
    { ...saved, transcriptId: 'other' },
    { ...saved, sequence: 0 },
    { ...saved, items: [memory.toJSON(), memory.toJSON()], sequence: 2 },
    { ...saved, items: [{ ...memory.toJSON(), sourceIndexes: [20] }] },
    { ...saved, items: [{ ...memory.toJSON(), sourceResults: [{ id: 'bad-source', kind: 'file-created', answerIndex: 0, receipt: { path: 'x', bytes: 1, digest: 'a'.repeat(64) } }] }] },
  ])
    assert.throws(() => Memories.restore(state, transcript, { persistence }));
  assert.equal(writes, 0);
});

test('accidentally asynchronous persistence never publishes or mutates content', async () => {
  const changes = new ChangeBuffer();
  const transcript = new Transcript([], {
    changes,
    persistence: {
      async commit() {
        throw new Error('async failure');
      },
    },
  });
  assert.throws(
    () => transcript.append(message('input')),
    (error) => error instanceof PersistenceError && error.operation === 'transcript.commit' && error.cause instanceof TypeError && /synchronously/.test(error.cause.message),
  );
  assert.equal(transcript.length, 0);
  assert.equal(transcript.revision, 0);
  const memories = new Memories(new Transcript([message('input')]), {
    changes,
    persistence: {
      async commit() {
        throw new Error('async failure');
      },
    },
  });
  assert.throws(
    () => memories.apply([create('one')]),
    (error) => error instanceof PersistenceError && error.operation === 'memories.commit' && error.cause instanceof TypeError && /synchronously/.test(error.cause.message),
  );
  assert.equal(memories.values().length, 0);
  assert.equal(memories.sequence, 0);
  assert.equal(changes.size, 0);
  await Promise.resolve();
});
