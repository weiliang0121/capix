import { installCallable } from '../../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defineScene, defineGroup, checkpointPoint, childReference, childReferences, MemoryCheckpointStore } from '@capix/server-runtime';

const mode = process.argv[2];
const variant = process.argv[3];
const codec = { encode: (value) => value, decode: (value) => value };
let calls = 0;
const definition = (checkpoint) =>
  defineGroup()({
    ...(checkpoint ? { checkpoint: { key: 'same-contract', version: 1, input: codec, output: codec, points: [] } } : {}),
    run: {
      execute: (work) => {
        calls++;
        return work.input;
      },
    },
  });
const a = definition(true);
const b = definition(true);
const plain = definition(false);
const point = checkpointPoint()({
  name: 'saved',
  state: {
    encode: (value) => value,
    decode(value) {
      if (value?.expected !== 'first' || value?.count !== 2) throw new Error('invalid state');
      return value;
    },
  },
  references: { chosen: childReference(a), all: childReferences(a), repeated: childReference(a) },
  check(state, facts) {
    assert.equal(facts.children.values().length, 4);
    assert.equal(facts.children.list(a).length, 2);
    assert.equal(facts.children.list(b).length, 1);
    assert.equal(facts.children.list(plain).length, 1);
    assert.equal(facts.references.chosen.returned.output, state.expected);
    assert.equal(facts.references.all.length, state.count);
    assert.equal(facts.references.chosen, facts.references.repeated);
    assert.equal(facts.references.all[1], facts.references.chosen);
    assert.equal(facts.children.require(a, facts.references.chosen.ref), facts.references.chosen);
    assert.equal(facts.children.get(facts.references.chosen.ref), facts.references.chosen);
    assert.throws(() => facts.children.require(b, facts.references.chosen.ref), /different declaration/);
    assert.equal(Object.isFrozen(facts.references.all), true);
  },
  resume: {
    uses: [a, b, plain],
    execute: (work, state, saved) => {
      const chosen = work.children.facts.get(saved.chosen);
      assert.equal(work.children.facts.require(a, saved.chosen).ref, saved.repeated);
      assert.equal(calls, 0, 'saved successful deliveries must not execute');
      return { state, output: chosen.returned.output, all: saved.all.map((ref) => work.children.facts.get(ref).returned.output), plain: work.children.facts.requireUnique(plain, { parentRound: 1 }).returned.output, children: work.children.facts.values().length, same: saved.chosen === saved.repeated };
    },
  },
});
const root = defineScene()({
  members: variant === 'swapped' ? [b, b, a, plain] : [a, a, b, plain],
  checkpoint: { key: 'author-parent', version: variant === 'version' ? 2 : 1, input: codec, output: codec, points: [point] },
  run: {
    execute: async (work) => {
      const first = work.children.create(a, 'first', { key: 'same-key' });
      const second = work.children.create(a, 'second', { key: 'same-key' });
      const other = work.children.create(b, 'other', { key: 'same-key' });
      const noCheckpoint = work.children.create(plain, 'plain', { key: 'same-key' });
      await Promise.all([first.run(), second.run(), other.run(), noCheckpoint.run()]);
      await first.accept((value) => value);
      if (variant === 'live-acceptance') await other.accept(() => new Date());
      const refs = { chosen: variant === 'wrong-declaration' ? other.ref : first.ref, all: [second.ref, first.ref], repeated: first.ref };
      if (variant === 'forged-reference') refs.chosen = {};
      const selected = variant === 'forged-point' ? { ...point } : point;
      work.checkpoint.save(selected, { expected: 'first', count: 2 }, refs);
      return 'unreachable';
    },
  },
});
const store = new MemoryCheckpointStore();
let contextId;
if (mode === 'capture') {
  const save = store.save.bind(store);
  store.save = (image, revision) => {
    const head = save(image, revision);
    if (image.contract.key === 'author-parent') {
      process.stdout.write(JSON.stringify(head));
      process.exit(0);
    }
    return head;
  };
} else {
  const head = JSON.parse(readFileSync(0, 'utf8'));
  store.save(head.image, 0);
  contextId = head.image.frame.owner.contextId;
}
const runtime = installCallable(root, { providers: [], source: { capture: () => null }, checkpoints: { store } });
try {
  if (mode === 'capture') await runtime.run({}, {});
  else {
    const result = await runtime.resume(contextId, {});
    process.stdout.write(JSON.stringify(result));
  }
} catch (error) {
  process.stderr.write(error.stack);
  process.exitCode = 1;
}
