import assert from 'node:assert/strict';

import { test } from 'node:test';

import { ChangeBuffer } from '@weiliang0121/capix-changes';

import { PersistenceError } from '@weiliang0121/capix-diagnostics';

import { Memories } from '@weiliang0121/capix-memory';

import { Transcript } from '@weiliang0121/capix-transcript';

const message = (content, role = 'user') => ({ role, content });

const create = (content, indexes = [0]) => ({ action: 'create', memoryId: null, change: 'new understanding', sourceIndexes: indexes, result: { topic: 'topic', content, sourceIndexes: indexes } });

const update = (memory, content) => ({ ...create(content), action: 'update', memoryId: memory.id });

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
