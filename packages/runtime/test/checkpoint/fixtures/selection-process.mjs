import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { Scene, Node, Runner, Resources, checkpointPoint, childReferences } from '@weiliang0121/capix-runtime';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { encodeCheckpointData, decodeCheckpointData } from '@weiliang0121/capix-checkpoint/storage';

const [mode, commitsPath, effectsPath] = process.argv.slice(2);
assert.ok(mode === 'seed' || mode === 'resume');
const memory = new MemoryCheckpointStore();
let contextId;
let recovered;
if (mode === 'resume') {
  // Files only transfer accepted public commits between test processes. This is
  // not a production Store or a crash-safe file persistence protocol.
  for (const line of readFileSync(commitsPath, 'utf8').trim().split('\n')) {
    const { commit, expectedRevision } = decodeCheckpointData(line);
    const receipt = memory.save(commit, expectedRevision);
    contextId = receipt.contextId;
  }
  recovered = memory.read(contextId);
  assert.equal(recovered.image.point, 'second');
  assert.equal(recovered.delivery, undefined);
}

const codec = { encode: (value) => value, decode: (value) => value };
const node = new Node({
  run(work) {
    if (mode === 'resume') assert.equal(work.input, 'c', 'completed children must not execute in the new process');
    appendFileSync(effectsPath, work.input + '\n');
    return work.input;
  },
});
const check = (state, facts) => {
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
      return selected.length;
    },
  },
});
const scene = new Scene({
  checkpoint: { key: 'selection.process', version: 1, input: codec, output: codec, points: [first, second] },
  async run(work) {
    assert.equal(mode, 'seed', 'resumption must not replay the original root');
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
    assert.fail('seed exits immediately after its saved cut');
  },
}).add({ node });
const writes = [];
const store = {
  read: (id) => memory.read(id),
  save(commit, expectedRevision) {
    const receipt = memory.save(commit, expectedRevision);
    writes.push({ point: commit.point, expectedRevision, changes: commit.selectionChanges ?? [], children: commit.children });
    if (mode === 'seed') {
      appendFileSync(commitsPath, encodeCheckpointData({ commit, expectedRevision }) + '\n');
      if (commit.point === 'second') {
        const head = memory.read(receipt.contextId);
        process.stdout.write(JSON.stringify({ pid: process.pid, contextId: receipt.contextId, revision: head.revision, delivery: head.delivery, selection: head.publication.selectedSelections[0], writes }));
        // A real process exit bypasses parent delivery and every finally path.
        process.exit(84);
      }
    }
    return receipt;
  },
  finish: (...args) => memory.finish(...args),
};
const runner = new Runner(scene, new Resources(), undefined, { checkpoints: { store } }).build();
const result = mode === 'seed' ? await runner.run(null) : await runner.resume(contextId);
const head = memory.read(contextId);
process.stdout.write(
  JSON.stringify({
    pid: process.pid,
    contextId,
    result,
    revision: head.revision,
    status: head.delivery.status,
    recoveredSelection: recovered.publication.selectedSelections[0],
    selection: head.publication.selectedSelections[0],
    orders: head.image.references.items.map((ref) => ref.order),
    relationCount: head.image.frame.children.length,
    outputs: head.image.frame.children.map((child) => child.state.output),
    writes,
  }),
);
