import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Scene, Group, Node, Runner, Resources, MemoryCheckpointStore, reception, checkpointPoint, childReference } from '@capix/server-runtime';

const codec = { encode: (value) => value, decode: (value) => value };
export const iso = '2026-10-25T00:00:00.000Z';

export function harness(store, counters, { failDuringHandling = false, reopen = false, checkResult = true, nested = false } = {}) {
  const primaryFailure = new Error('primary source failed');
  const leaf = new Node({
    run() {
      counters.primary++;
      throw primaryFailure;
    },
  });
  const primary = nested ? new Group({ run: (work) => work.children.invoke(leaf, null) }).add(leaf) : leaf;
  const backup = new Node({
    run() {
      counters.backup++;
      return iso;
    },
  });
  const contract = reception(primary, {
    check(value) {
      assert.ok(value instanceof Date && Number.isFinite(value.getTime()));
      return value;
    },
    encode: (value) => value.toISOString(),
    decode(value) {
      assert.equal(typeof value, 'string');
      return new Date(value);
    },
  });
  const point = checkpointPoint()({
    name: 'handled',
    state: codec,
    references: { primary: childReference(primary) },
    check(_state, facts) {
      const first = facts.references.primary;
      assert.equal(first.returned.status, 'failed');
      assert.equal(first.reception.status, 'handled');
      if (checkResult) assert.equal(facts.children.handled(first.ref, contract).toISOString(), iso);
    },
    resume: {
      async run(work, _state, refs) {
        const first = work.children.facts.get(refs.primary);
        assert.equal(first.returned.status, 'failed');
        assert.equal(first.reception.status, 'handled');
        assert.equal(first.returned.diagnostic instanceof Error, false);
        assert.equal(first.returned.diagnostic.message, 'primary source failed');
        const value = work.children.facts.handled(refs.primary, contract);
        assert.ok(value instanceof Date);
        if (reopen) return work.children.open(refs.primary).run();
        work.checkpoint({ point, state: null, refs });
        return value.toISOString();
      },
    },
  });
  const scene = new Scene({
    checkpoint: { receptions: [contract], key: 'fixture.handled.root', version: 1, input: codec, output: codec, points: [point] },
    async run(work) {
      const value = await work.children.invoke(primary, null, {
        reception: contract,
        result: {
          async failed(error) {
            counters.handled++;
            assert.equal(error, primaryFailure);
            if (failDuringHandling) {
              const first = work.children.facts.requireUnique(primary, { parentRound: 1 });
              work.checkpoint({ point, state: null, refs: { primary: first.ref } });
            }
            return new Date(await work.children.invoke(backup, null));
          },
        },
      });
      const first = work.children.facts.requireUnique(primary, { parentRound: 1 });
      assert.equal(first.returned.status, 'failed');
      assert.equal(first.reception.status, 'handled');
      assert.equal(work.children.facts.handled(first.ref, contract), value);
      work.checkpoint({ point, state: null, refs: { primary: first.ref } });
      return value.toISOString();
    },
  }).add(primary, backup);
  return new Runner(scene, new Resources(), undefined, { checkpoints: { store } }).build();
}

export async function capture(options) {
  const images = [];
  const memory = new MemoryCheckpointStore();
  const store = {
    read: (id) => memory.read(id),
    save(image, revision) {
      images.push(image);
      return memory.save(image, revision);
    },
    finish: (id, revision, delivery) => memory.finish(id, revision, delivery),
  };
  const counters = { primary: 0, backup: 0, handled: 0 };
  const result = await harness(store, counters, options).run(null);
  return { image: images[0], counters, result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'capture') process.stdout.write(JSON.stringify(await capture({ nested: process.argv[3] === 'nested' })));
  else if (mode === 'restore') {
    const image = JSON.parse(readFileSync(0, 'utf8'));
    const store = new MemoryCheckpointStore();
    store.save(image, 0);
    const counters = { primary: 0, backup: 0, handled: 0 };
    const result = await harness(store, counters, { nested: process.argv[3] === 'nested' }).resume(image.frame.owner.contextId);
    process.stdout.write(JSON.stringify({ result, counters, image: store.read(image.frame.owner.contextId).image }));
  } else throw new Error('Unknown handled fixture mode');
}
