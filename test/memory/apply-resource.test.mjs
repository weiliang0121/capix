import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeError } from '@capix/contracts';
import { PersistenceError } from '@capix/diagnostics';
import { Memories, Memory, MemoryResource } from '@capix/memory';
import { Resource, Resources, ResourceAccessClosed } from '@capix/resources';
import { Transcript } from '@capix/transcript';

const create = (content) => ({ action: 'create', memoryId: null, change: 'create memory', sourceIndexes: [0], result: { topic: 'topic', content, sourceIndexes: [0] } });
const update = (memory, content) => ({ ...create(content), action: 'update', memoryId: memory.id });
const transcript = () =>
  new Transcript([
    { role: 'user', content: 'input' },
    { role: 'assistant', content: 'answer' },
  ]);
const basis = (memories) => ({ memoriesId: memories.id, transcriptId: memories.transcript.id, sequence: memories.sequence });
const conflict = (error) => error instanceof RuntimeError && !(error instanceof PersistenceError) && error.code === 'MEMORY_BASIS_CONFLICT';

function open(memories, publish = () => {}) {
  const facts = [];
  const access = new Resources()
    .register(new Resource(memories), MemoryResource.apply)
    .bind({ memory: MemoryResource.apply.request() })
    .open({
      contextId: 'memory-application',
      failures: { isProtected: (error) => error instanceof PersistenceError, isCancellation: () => false, describe: (error) => ({ message: error.message }) },
      validate() {},
      observation: {
        publish(fact) {
          facts.push(fact);
          publish(fact);
        },
      },
    });
  return { access, endpoint: access.endpoints.memory, facts };
}

test('memory resource returns the real identities and snapshots of only applied changes in batch order', () => {
  const memories = new Memories(transcript());
  const { access, endpoint } = open(memories);
  try {
    const initial = endpoint.apply([create('one'), create('two'), create('untouched')], basis(memories));
    assert.deepEqual(initial, { memoriesId: memories.id, transcriptId: memories.transcript.id, startSequence: 0, sequence: 3, items: memories.snapshot() });
    const [first, second] = initial.items;
    const application = endpoint.apply([update(first, 'one'), update(second, 'changed'), create('new')], basis(memories));
    assert.equal(application.startSequence, 3);
    assert.equal(application.sequence, 5);
    assert.equal(application.memoriesId, memories.id);
    assert.equal(application.transcriptId, memories.transcript.id);
    assert.deepEqual(
      application.items.map((item) => item.content),
      ['changed', 'new'],
    );
    assert.equal(application.items[0].id, second.id);
    assert.notEqual(application.items[1].id, first.id);
    assert.notEqual(application.items[1].id, second.id);
    for (const item of application.items) {
      assert.deepEqual(item, memories.get(item.id).toJSON());
      assert.notEqual(item, memories.get(item.id));
      assert.equal(item instanceof Memory, false);
    }
  } finally {
    access.close();
  }
});

test('empty and unchanged applications return an empty frozen increment without advancing sequence or persisting', () => {
  let commits = 0;
  const memories = new Memories(transcript(), {
    persistence: {
      commit() {
        commits++;
      },
    },
  });
  const { access, endpoint } = open(memories);
  try {
    const [memory] = endpoint.apply([create('same')]).items;
    for (const changes of [[], [update(memory, 'same')]]) {
      const application = endpoint.apply(changes, basis(memories));
      assert.deepEqual(application, { ...basis(memories), startSequence: 1, items: [] });
      assert.equal(commits, 1);
      assert.equal(memories.sequence, 1);
      assert.ok(Object.isFrozen(application));
      assert.ok(Object.isFrozen(application.items));
    }
  } finally {
    access.close();
  }
});

test('stale and foreign bases reject a complete batch before writing, including otherwise empty applications', () => {
  const commits = [];
  const memories = new Memories(transcript(), {
    persistence: {
      commit(change) {
        commits.push(change);
      },
    },
  });
  const { access, endpoint } = open(memories);
  try {
    const stale = basis(memories);
    const [memory] = endpoint.apply([create('original')], stale).items;
    const current = basis(memories);
    const before = memories.exportState();
    for (const expected of [stale, { ...current, memoriesId: new Memories(memories.transcript).id }, { ...current, transcriptId: transcript().id }, { ...current, sequence: current.sequence + 1 }]) {
      for (const changes of [[], [update(memory, 'changed'), create('new')]]) {
        assert.throws(() => endpoint.apply(changes, expected), conflict);
        assert.deepEqual(memories.exportState(), before);
        assert.equal(commits.length, 1);
      }
    }
  } finally {
    access.close();
  }
});

test('invalid expected basis values fail before any application or persistence', () => {
  let commits = 0;
  const memories = new Memories(transcript(), {
    persistence: {
      commit() {
        commits++;
      },
    },
  });
  const { access, endpoint } = open(memories);
  try {
    const valid = basis(memories);
    const invalid = [null, [], false, 0, 'basis', {}, { ...valid, memoriesId: '' }, { ...valid, memoriesId: 1 }, { ...valid, transcriptId: ' ' }, { ...valid, transcriptId: null }, ...[-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '0', undefined].map((sequence) => ({ ...valid, sequence }))];
    for (const expected of invalid) assert.throws(() => endpoint.apply([create('rejected')], expected), TypeError);
    assert.equal(memories.sequence, 0);
    assert.deepEqual(memories.values(), []);
    assert.equal(commits, 0);
  } finally {
    access.close();
  }
});

test('expected basis is checked inside the operation after its started observation', () => {
  const memories = new Memories(transcript());
  const expected = basis(memories);
  let changed = false;
  const { access, endpoint } = open(memories, (fact) => {
    if (fact.phase === 'started' && !changed) {
      changed = true;
      memories.apply([create('concurrent change')]);
    }
  });
  try {
    assert.throws(() => endpoint.apply([create('stale proposal')], expected), conflict);
    assert.equal(memories.sequence, 1);
    assert.deepEqual(
      memories.values().map((memory) => memory.content),
      ['concurrent change'],
    );
  } finally {
    access.close();
  }
});

test('persistence failure preserves the original state and never returns a successful application', () => {
  const failure = new Error('store unavailable');
  let reject = false;
  let commits = 0;
  const memories = new Memories(transcript(), {
    persistence: {
      commit() {
        commits++;
        if (reject) throw failure;
      },
    },
  });
  const { access, endpoint, facts } = open(memories);
  try {
    const [memory] = endpoint.apply([create('original')]).items;
    const before = memories.exportState();
    reject = true;
    assert.throws(
      () => endpoint.apply([update(memory, 'changed'), create('new')], basis(memories)),
      (error) => error instanceof PersistenceError && error.cause === failure,
    );
    assert.equal(commits, 2);
    assert.deepEqual(memories.exportState(), before);
    assert.equal(facts.filter((fact) => fact.phase === 'returned').length, 1);
    assert.equal(facts.at(-1).phase, 'threw');
  } finally {
    access.close();
  }
});

test('expired access rejects apply before checking the basis or changing memory', () => {
  const memories = new Memories(transcript());
  const { access, endpoint } = open(memories);
  access.close();
  for (const expected of [undefined, basis(memories), null]) assert.throws(() => endpoint.apply([create('closed')], expected), ResourceAccessClosed);
  assert.equal(memories.sequence, 0);
  assert.deepEqual(memories.values(), []);
});

test('a started observation that closes the window prevents the application', () => {
  const memories = new Memories(transcript());
  const { access, endpoint } = open(memories, (fact) => {
    if (fact.phase === 'started') access.close();
  });
  assert.throws(() => endpoint.apply([create('closed')], basis(memories)), ResourceAccessClosed);
  assert.equal(memories.sequence, 0);
  assert.deepEqual(memories.values(), []);
});

test('application snapshots remain frozen and independent of later changes to proposals or live memories', () => {
  const memories = new Memories(transcript());
  const { access, endpoint } = open(memories);
  const proposed = create('original');
  proposed.result.sourceIndexes.push(1);
  proposed.result.sourceResults = [{ id: 'creation-1', kind: 'file-created', answerIndex: 1, receipt: { path: 'answer.md', bytes: 12, digest: 'a'.repeat(64) } }];
  const application = endpoint.apply([proposed]);
  const item = application.items[0];
  for (const value of [application, application.items, item, item.sourceIndexes, item.sourceResults, item.sourceResults[0], item.sourceResults[0].receipt]) assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    item.content = 'rewritten';
  }, TypeError);
  assert.throws(() => {
    application.items.push(item);
  }, TypeError);
  proposed.result.content = 'changed proposal';
  proposed.result.sourceIndexes.push(99);
  proposed.result.sourceResults[0].receipt.path = 'rewritten.md';
  endpoint.apply([update(item, 'new live content')]);
  access.close();
  assert.equal(memories.get(item.id).content, 'new live content');
  assert.equal(item.content, 'original');
  assert.deepEqual(item.sourceIndexes, [0, 1]);
  assert.equal(item.sourceResults[0].receipt.path, 'answer.md');
  assert.equal(application.sequence, 1);
});

test('resource observation retains actual counts, sequences and changed IDs without exposing memory content', () => {
  const memories = new Memories(transcript());
  let injected = false;
  const { access, endpoint, facts } = open(memories, (fact) => {
    if (fact.phase === 'started' && !injected) {
      injected = true;
      memories.apply([create('outside write')]);
    }
  });
  try {
    const initial = endpoint.apply([create('private original')]);
    const [item] = initial.items;
    endpoint.apply([update(item, 'private original')]);
    endpoint.apply([update(item, 'private changed')]);
    const operations = facts.filter((fact) => fact.phase === 'started' || fact.phase === 'returned').map((fact) => ({ phase: fact.phase, detail: fact.describe() }));
    assert.deepEqual(operations, [
      { phase: 'started', detail: { action: 'apply', input: { count: 1 } } },
      { phase: 'returned', detail: { action: 'apply', output: { memoriesId: memories.id, startSequence: 1, endSequence: 2, memoryIds: [item.id] } } },
      { phase: 'started', detail: { action: 'apply', input: { count: 1 } } },
      { phase: 'returned', detail: { action: 'apply', output: { memoriesId: memories.id, startSequence: 2, endSequence: 2, memoryIds: [] } } },
      { phase: 'started', detail: { action: 'apply', input: { count: 1 } } },
      { phase: 'returned', detail: { action: 'apply', output: { memoriesId: memories.id, startSequence: 2, endSequence: 3, memoryIds: [item.id] } } },
    ]);
    assert.equal(JSON.stringify(operations).includes('private'), false);
    assert.equal(initial.startSequence, 1);
    assert.equal(initial.sequence, 2);
  } finally {
    access.close();
  }
});
