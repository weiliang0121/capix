import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Scene, Node, checkpointPoint, childReference, childReferences } from '@weiliang0121/capix-structure';

import { Runner, Resources } from '@weiliang0121/capix-runtime';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

const codec = { encode: (value) => value, decode: (value) => value };

function fixture(run, { check = () => {} } = {}) {
  const makeNode = (key) => {
    const completed = checkpointPoint()({ name: 'completed', state: codec, references: {}, resume: { run: (_work, state) => state } });
    return new Node({
      checkpoint: { key, version: 1, input: codec, output: codec, points: [completed] },
      run(work) {
        work.checkpoint({ point: completed, state: work.input });
        return work.input;
      },
    });
  };
  const node = makeNode('selection.child');
  const other = makeNode('selection.other');
  const point = (name, references) => checkpointPoint()({ name, state: codec, references, check, resume: { run: () => 0 } });
  const first = point('first', { children: childReferences(node) });
  const second = point('second', { renamed: childReferences(node) });
  const wrong = point('wrong', { children: childReferences(other) });
  const single = point('single', { child: childReference(node) });
  const scene = new Scene({ checkpoint: { key: 'selection.author', version: 1, input: codec, output: codec, points: [first, second, wrong, single] } }).add({ node, other });
  scene.run = (work) => run(work, { node, other, first, second, wrong, single });
  const store = new MemoryCheckpointStore();
  let latest;
  const save = store.save.bind(store);
  store.save = (commit, revision) => {
    latest = save(commit, revision);
    return latest;
  };
  return {
    store,
    runner: new Runner(scene, new Resources(), undefined, { checkpoints: { store } }).build(),
    get latest() {
      return latest;
    },
  };
}

test('authors explicitly reuse one ordered selection across compatible point aliases', async () => {
  const observed = [];
  let escaped;
  let childReference;
  const h = fixture(
    async (work, { node, first, second }) => {
      const child = work.children.create(node, 7);
      childReference = child.ref;
      const selection = work.checkpoint.select(node);
      escaped = selection;
      const firstAppearance = selection.add(child.ref);
      const secondAppearance = selection.add(child.ref);
      assert.notEqual(firstAppearance, secondAppearance);
      assert.equal(selection.occurrenceAt(0), firstAppearance);
      assert.equal(selection.occurrenceAt(-1), secondAppearance);
      assert.equal(selection.at(-1), child.ref);
      assert.deepEqual([...selection], [child.ref, child.ref]);
      work.checkpoint({ point: first, state: 2, refs: { children: selection } });
      assert.equal(await child.invoke(), 7);
      selection.remove(firstAppearance);
      assert.equal(selection.length, 1);
      assert.equal(selection.occurrenceAt(0), secondAppearance);
      work.checkpoint({ point: second, state: 1, refs: { renamed: selection } });
      return 7;
    },
    {
      check(state, facts) {
        const refs = facts.references.children ?? facts.references.renamed;
        observed.push(refs.map((fact) => fact.order));
        assert.equal(refs.length, state);
      },
    },
  );
  assert.equal(await h.runner.run(null), 7);
  assert.deepEqual(observed, [[0, 0], [0]]);
  const head = h.store.read(h.latest.contextId);
  assert.equal(head.image.point, 'second');
  assert.deepEqual(Object.keys(head.image.references), ['renamed']);
  assert.equal(head.image.references.renamed.length, 1);
  assert.equal(head.image.frame.children.length, 1, 'removing an occurrence does not remove the relationship');
  assert.throws(() => escaped.add(childReference), /active|closed|finished|ended/i);
  assert.throws(() => escaped.length, /active|closed|finished|ended/i);
});

test('plain arrays keep full replacement and single refs keep their old shape', async () => {
  const h = fixture(async (work, { node, first, single }) => {
    const child = work.children.create(node, 3);
    const selection = work.checkpoint.select(node, [child.ref, child.ref]);
    work.checkpoint({ point: first, state: null, refs: { children: selection } });
    work.checkpoint({ point: first, state: null, refs: { children: [] } });
    await child.invoke();
    work.checkpoint({ point: single, state: null, refs: { child: child.ref } });
    return 3;
  });
  assert.equal(await h.runner.run(null), 3);
  assert.equal(Array.isArray(h.store.read(h.latest.contextId).image.references.child), false);
});

for (const variant of ['wrong-child', 'wrong-slot', 'single-slot', 'foreign-occurrence', 'removed-occurrence', 'forged-handle'])
  test(`author selection rejects ${variant}`, async () => {
    const h = fixture((work, { node, other, first, wrong, single }) => {
      const child = work.children.create(node, 1);
      const selection = work.checkpoint.select(node);
      const occurrence = selection.add(child.ref);
      if (variant === 'wrong-child') selection.add(work.children.create(other, 2).ref);
      else if (variant === 'foreign-occurrence') work.checkpoint.select(node).remove(occurrence);
      else if (variant === 'removed-occurrence') {
        selection.remove(occurrence);
        selection.remove(occurrence);
      } else if (variant === 'wrong-slot') work.checkpoint({ point: wrong, state: null, refs: { children: selection } });
      else if (variant === 'single-slot') work.checkpoint({ point: single, state: null, refs: { child: selection } });
      else work.checkpoint({ point: first, state: null, refs: { children: { length: 1, at: () => child.ref } } });
      return 0;
    });
    const expected = variant === 'wrong-child' ? /child declaration differs/ : variant === 'wrong-slot' ? /targets a different child declaration/ : variant === 'single-slot' ? /cardinality/ : variant === 'forged-handle' ? /foreign child reference/ : /occurrence does not belong/;
    await assert.rejects(h.runner.run(null), expected);
    assert.equal(h.latest, undefined);
  });

test('a previous invocation selection cannot be submitted by a later call', async () => {
  let selected;
  const h = fixture(async (work, { node, first }) => {
    if (work.input === 'first') {
      const child = work.children.create(node, 1);
      selected = work.checkpoint.select(node);
      selected.add(child.ref);
      await child.invoke();
      work.checkpoint({ point: first, state: null, refs: { children: selected } });
      return 1;
    }
    work.checkpoint({ point: first, state: null, refs: { children: selected } });
    return 2;
  });
  assert.equal(await h.runner.run('first'), 1);
  const prior = h.latest;
  await assert.rejects(h.runner.run('second'), /selection belongs to another invocation/);
  assert.equal(h.latest, prior);
});
