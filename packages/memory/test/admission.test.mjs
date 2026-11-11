import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeBuffer } from '@weiliang0121/capix-changes';
import { Memories } from '@weiliang0121/capix-memory';
import { create, update, fixed } from './support.mjs';

for (const mode of ['apply', 'applyFixed']) {
  test(`${mode} rejects accessors without executing them or committing an earlier command`, () => {
    let getters = 0;
    const commits = [];
    const changes = new ChangeBuffer();
    const memories = new Memories({
      changes,
      persistence: {
        commit: (value) => {
          commits.push(value);
        },
      },
    });
    const invalid = {
      action: 'create',
      get value() {
        getters++;
        return { content: 'hidden' };
      },
    };
    const mutations = [create('first'), invalid];
    assert.throws(() => (mode === 'apply' ? memories.apply(mutations) : memories.applyFixed(fixed(memories, mutations))));
    assert.equal(getters, 0);
    assert.equal(memories.sequence, 0);
    assert.deepEqual(memories.values(), []);
    assert.deepEqual(commits, []);
    assert.equal(changes.size, 0);
  });
  test(`${mode} rejects an invalid later command and duplicate updates atomically`, () => {
    const memories = new Memories();
    const id = memories.apply([create('old')]).changed[0].id;
    const before = memories.exportState();
    for (const mutations of [
      [create('new'), create('')],
      [update(id, 'first'), update(id, 'second')],
      [create('new'), update('missing', 'bad')],
    ]) {
      assert.throws(() => (mode === 'apply' ? memories.apply(mutations) : memories.applyFixed(fixed(memories, mutations))));
      assert.deepEqual(memories.exportState(), before);
    }
  });
}

test('expected basis is fixed inside the entity mutation guard, not in a resource precheck', () => {
  const memories = new Memories();
  let getters = 0;
  const expected = {
    memoriesId: memories.id,
    get sequence() {
      getters++;
      memories.apply([create('reentry')]);
      return 0;
    },
  };
  assert.throws(() => memories.apply([create('outside')], { expected }));
  assert.equal(getters, 0);
  assert.equal(memories.sequence, 0);
  let attempted = 0;
  const proxy = new Proxy(
    { memoriesId: memories.id, sequence: 0 },
    {
      ownKeys(target) {
        attempted++;
        assert.throws(() => memories.apply([create('nested')]), /reenter|mutation/i);
        return Reflect.ownKeys(target);
      },
    },
  );
  memories.apply([create('valid')], { expected: proxy });
  assert.equal(attempted, 1);
  assert.equal(memories.sequence, 1);
});

test('fixed operation rejects accessor-bearing identities without publishing or installing a receipt', () => {
  const memories = new Memories();
  const request = fixed(memories, [create('accepted')]);
  let reads = 0;
  Object.defineProperty(request.command, 'changes', {
    enumerable: true,
    get() {
      reads++;
      request.command.position = 'changed';
      return [];
    },
  });
  assert.throws(() => memories.applyFixed(request));
  assert.equal(reads, 0);
  assert.equal(memories.sequence, 0);
  assert.equal(memories.exportState().applies?.length ?? 0, 0);
});

test('content contract is fixed, synchronous and validates a stable value without replacing it', async () => {
  const definition = {
    key: 'notes.positive',
    version: 1,
    check(value) {
      assert.ok(Object.isFrozen(value));
      if (value.metadata.score < 0) throw new TypeError('negative score');
      return { content: 'not a transformation' };
    },
  };
  const memories = new Memories({ contentContract: definition });
  definition.key = 'mutated';
  definition.check = () => assert.fail('binding must retain original check');
  const item = memories.apply([create('original', { score: 1 })]).changed[0];
  assert.equal(item.value.content, 'original');
  assert.equal(memories.contentContract.key, 'notes.positive');
  assert.throws(() => memories.apply([create('invalid', { score: -1 })]), /negative score/);
  const saved = memories.exportState();
  assert.throws(() => Memories.restore(saved), /contract/i);
  let checks = 0;
  Memories.restore(saved, {
    contentContract: {
      key: 'notes.positive',
      version: 1,
      check() {
        checks++;
      },
    },
  });
  assert.ok(checks > 0);
  for (const check of [async () => {}, () => Promise.reject(new Error('late rejection'))]) {
    const invalid = new Memories({ contentContract: { key: 'async', version: 1, check } });
    assert.throws(() => invalid.apply([create('candidate')]));
    assert.equal(invalid.sequence, 0);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test('fixed request requires the current command boundary without accepting flattened or extra author fields', () => {
  const memories = new Memories();
  const request = fixed(memories, []);
  const { command, ...envelope } = request;
  for (const invalid of [
    { ...envelope, operation: { ...envelope.operation, position: command.position }, changes: command.changes },
    { ...request, command: { ...command, topic: 'unsupported' } },
    { ...request, operation: { ...request.operation, position: command.position } },
  ])
    assert.throws(() => memories.applyFixed(invalid));
  assert.equal(memories.sequence, 0);
  assert.equal(memories.exportState().applies, undefined);
});
