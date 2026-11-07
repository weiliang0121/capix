import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { Scene, Node, Runner, Resources, checkpointPoint, childReferences } from '@capix/server-runtime';
import { ConversationStore } from '@capix/conversation-service/persistence';

const [mode, path, marker, effects] = process.argv.slice(2);
const codec = { encode: (value) => value, decode: (value) => value };
const host = ConversationStore.open(path);
const node = new Node({
  run(work) {
    appendFileSync(effects, work.input + '\n');
    return work.input;
  },
});
const check = (state, facts) => {
  assert.equal(facts.references.items.length, state.values.length);
  assert.deepEqual(
    facts.references.items.map((fact) => fact.returned.output),
    state.values,
  );
};
const first = checkpointPoint()({ name: 'first', state: codec, references: { items: childReferences(node) }, check, resume: { run: () => assert.fail('wrong recovery point') } });
const second = checkpointPoint()({
  name: 'second',
  state: codec,
  references: { items: childReferences(node) },
  check,
  resume: {
    uses: [node],
    async run(work, state, saved) {
      assert.deepEqual(state.values, ['a', 'b']);
      const selected = work.checkpoint.select(node, saved.items);
      assert.equal(selected.length, 2);
      const original = selected.occurrenceAt(0);
      assert.ok(original);
      selected.remove(original);
      const call = work.children.create(node, 'c');
      await call.invoke();
      selected.add(call.ref);
      work.checkpoint({ point: first, state: { values: ['b', 'c'] }, refs: { items: selected } });
      work.checkpoint({ point: second, state: { values: ['b', 'c'] }, refs: { items: selected } });
      return 2;
    },
  },
});
const scene = new Scene({
  checkpoint: { key: 'selection.process', version: 1, input: codec, output: codec, points: [first, second] },
  async run(work) {
    assert.equal(mode, 'seed', 'resumption must not rerun the original root');
    const selected = work.checkpoint.select(node);
    const a = work.children.create(node, 'a');
    await a.invoke();
    const original = selected.add(a.ref);
    selected.add(a.ref);
    work.checkpoint({ point: first, state: { values: ['a', 'a'] }, refs: { items: selected } });
    const b = work.children.create(node, 'b');
    await b.invoke();
    selected.add(b.ref);
    selected.remove(original);
    work.checkpoint({ point: second, state: { values: ['a', 'b'] }, refs: { items: selected } });
    assert.fail('seed exits at the durable cut');
  },
}).add({ node });
const writes = [];
const store = {
  read: (id) => host.checkpoints.read(id),
  save(commit, revision) {
    writes.push({ point: commit.point, changes: commit.selectionChanges ?? [], values: commit.values?.length });
    const receipt = host.checkpoints.save(commit, revision);
    if (mode === 'seed' && commit.point === 'second') {
      writeFileSync(marker, receipt.contextId);
      // Bypass all finally/finish paths, just after the atomic durable commit.
      process.exit(84);
    }
    return receipt;
  },
  finish: (...args) => host.checkpoints.finish(...args),
};
try {
  const runner = new Runner(scene, new Resources(), undefined, { checkpoints: { store } }).build();
  const result = mode === 'seed' ? await runner.run(null) : await runner.resume(readFileSync(marker, 'utf8'));
  const head = host.checkpoints.read(readFileSync(marker, 'utf8'));
  console.log(JSON.stringify({ result, writes, orders: head.image.references.items.map((ref) => ref.order), relationCount: head.image.frame.children.length, status: head.delivery.status }));
} finally {
  host.close();
}
