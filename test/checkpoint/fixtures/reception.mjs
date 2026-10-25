import { installCallable } from '../../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defineScene, defineGroup, reception, checkpointPoint, childReference, MemoryCheckpointStore } from '@capix/server-runtime';

const mode = process.argv[2];
const variant = process.argv[3];
const codec = { encode: (value) => value, decode: (value) => value };
let runs = 0;
let acceptances = 0;
const child = defineGroup()({
  run: (work) => {
    runs++;
    return work.input;
  },
});
const dateValue = {
  check(value) {
    assert.ok(value instanceof Date && Number.isFinite(value.getTime()));
    return value;
  },
  encode(value) {
    return value.toISOString();
  },
  decode(value) {
    if (variant === 'reject-codec') throw new Error('fixture rejects date encoding');
    return new Date(value);
  },
};
const dateReception = reception(child, dateValue);
const anotherDateReception = reception(child, dateValue);
const emptyReception = reception(child, {
  check(value) {
    assert.equal(value, undefined);
    return value;
  },
  encode() {
    return null;
  },
  decode(value) {
    assert.equal(value, null);
    return undefined;
  },
});
const checkValues = (facts, refs) => {
  const first = facts.accepted(refs.first, dateReception);
  const second = facts.accepted(refs.second, dateReception);
  assert.ok(first instanceof Date);
  assert.ok(second instanceof Date);
  assert.notEqual(first, second);
  assert.equal(first.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(second.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(facts.accepted(refs.empty, emptyReception), undefined);
  assert.equal(facts.get(refs.empty).reception.status, 'accepted');
  return first;
};
const point = checkpointPoint()({
  name: 'saved',
  state: codec,
  references: { first: childReference(child), second: childReference(child), empty: childReference(child) },
  check(_state, facts) {
    checkValues(facts.children, Object.fromEntries(Object.entries(facts.references).map(([name, fact]) => [name, fact.ref])));
  },
  resume: {
    run(work, _state, refs) {
      const first = checkValues(work.children.facts, refs);
      if (variant === 'wrong-contract') work.children.facts.accepted(refs.first, anotherDateReception);
      assert.equal(runs, 0);
      assert.equal(acceptances, 0);
      return { value: first.toISOString(), pid: process.pid, empty: work.children.facts.get(refs.empty).reception.status };
    },
  },
});
const root = defineScene()({
  members: [child],
  checkpoint: { receptions: variant === 'swap' ? [emptyReception, dateReception, anotherDateReception] : [dateReception, emptyReception, anotherDateReception], key: 'typed-reception-parent', version: variant === 'version' ? 2 : 1, input: codec, output: codec, points: [point] },
  async run(work) {
    const first = work.children.create(child, '2026-01-01T00:00:00.000Z', { key: 'same-key' });
    const second = work.children.create(child, '2026-02-01T00:00:00.000Z', { key: 'same-key' });
    const empty = work.children.create(child, 'unused');
    await Promise.all([first.run(), second.run(), empty.run()]);
    await first.accept(dateReception, (value) => {
      acceptances++;
      return new Date(value);
    });
    await second.accept(dateReception, (value) => {
      acceptances++;
      return new Date(value);
    });
    await empty.accept(emptyReception, () => undefined);
    work.checkpoint({ point: point, state: { pid: process.pid }, refs: { first: first.ref, second: second.ref, empty: empty.ref } });
    return 'unreachable';
  },
});
const store = new MemoryCheckpointStore();
let contextId;
if (mode === 'capture') {
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
  const result = mode === 'capture' ? await runtime.run({}, {}) : await runtime.resume(contextId, {});
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error.stack);
  process.exitCode = 1;
}
