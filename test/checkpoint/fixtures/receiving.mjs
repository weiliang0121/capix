import { installCallable } from '../../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defineScene, defineGroup, reception, checkpointPoint, childReference } from '@capix/server-runtime';
import { MemoryCheckpointStore } from '@capix/checkpoint';

const mode = process.argv[2];
const variant = process.argv[3];
const codec = { encode: (value) => value, decode: (value) => value };
let runs = 0;
let callbacks = 0;
const child = defineGroup()({
  run: () => {
    runs++;
    return '2026-01-01T00:00:00.000Z';
  },
});
const value = {
  check: (item) => {
    assert.ok(item instanceof Date);
    return item;
  },
  encode: (item) => item.toISOString(),
  decode: (item) => new Date(item),
};
const original = reception(child, value);
const other = reception(child, value);
const point = checkpointPoint()({
  name: 'receiving',
  state: codec,
  references: { selected: childReference(child) },
  check(_state, facts) {
    assert.equal(facts.references.selected.reception.status, 'receiving');
  },
  resume: {
    async run(work, _state, refs) {
      const handle = work.children.open(refs.selected);
      const receive = (output) => {
        callbacks++;
        return new Date(output);
      };
      const result = variant === 'raw' ? await handle.accept(receive) : await handle.accept(variant === 'other' ? other : original, receive);
      assert.equal(runs, 0);
      assert.equal(callbacks, 1);
      return result.toISOString();
    },
  },
});
const root = defineScene()({
  members: [child],
  checkpoint: { receptions: [original, other], key: 'receiving-parent', version: 1, input: codec, output: codec, points: [point] },
  async run(work) {
    const handle = work.children.create(child, null);
    await handle.run();
    const receive = (output) => {
      work.checkpoint({ point: point, state: null, refs: { selected: handle.ref } });
      return new Date(output);
    };
    return mode === 'capture-raw' ? handle.accept(receive) : handle.accept(original, receive);
  },
});
const store = new MemoryCheckpointStore();
let contextId;
if (mode.startsWith('capture')) {
  const save = store.save.bind(store);
  store.save = (image, revision) => {
    const head = save(image, revision);
    process.stdout.write(JSON.stringify(head));
    process.exit(0);
  };
} else {
  const head = JSON.parse(readFileSync(0, 'utf8'));
  store.save(head.image, 0);
  contextId = head.image.frame.owner.contextId;
}
const runtime = installCallable(root, { providers: [], source: { capture: () => null }, checkpoints: { store } });
try {
  const result = mode.startsWith('capture') ? await runtime.run(null, {}) : await runtime.resume(contextId, {});
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`${error.stack}\ncallbacks:${callbacks}`);
  process.exitCode = 1;
}
