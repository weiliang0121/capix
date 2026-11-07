import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Invocation, InvocationContext } from '@capix/server-runtime';
import { MemoryCheckpointStore, cloneCheckpointHead, checkpointReference } from '@capix/checkpoint';

const codec = { encode: (value) => value, decode: (value) => value };
const store = new MemoryCheckpointStore();
let restore = process.argv[2] === 'restore' ? cloneCheckpointHead(JSON.parse(readFileSync(0, 'utf8'))) : undefined;
if (restore) {
  store.save(restore.image, 0);
  // Full-image import establishes this Store's physical publication references.
  restore = store.read(restore.image.frame.owner.contextId);
}
const context = new InvocationContext({ request: 'start' });
if (restore) context.installCheckpoint({ id: restore.image.frame.owner.contextId, round: restore.image.frame.round, currentInput: restore.image.frame.currentInput });
const signal = new AbortController().signal;
const checkpoint = {
  key: 'process-parent',
  version: 1,
  input: codec,
  output: codec,
  children: [{ kind: 'node' }],
  points: {
    saved: {
      state: codec,
      references: { selected: { cardinality: 'one', position: 0 } },
      check(frame, state, refs, facts) {
        assert.equal(frame.children.length, 1);
        assert.equal(refs.selected.contextId, frame.children[0].identity.contextId);
        assert.equal(facts.children[0].state.output, 'external result');
        assert.equal(state.accepted, frame.children[0].state.reception.kind === 'accepted');
      },
      async execute(_context, invocation, _state, refs) {
        const child = invocation.restoreChild(0, refs.selected.contextId, () => assert.fail('successful no-CP child must not execute'));
        assert.equal(await child.run(), 'external result');
        const result = await invocation.children.get(child).accept((output) => `${output}:accepted`);
        invocation.checkpointWriter.save('saved', { accepted: true }, refs);
        return result;
      },
    },
  },
};
const invocation = new Invocation({
  context,
  identity: { contextId: context.id, kind: 'group' },
  signal,
  checkpoints: { store },
  ...(restore ? { restore: { head: restore } } : {}),
  work: {
    maxRounds: 1,
    checkpoint,
    async execute(_context, parent) {
      const childContext = new InvocationContext({ request: 'external' });
      const child = new Invocation({ context: childContext, signal, identity: { contextId: childContext.id, parentContextId: context.id, kind: 'node' }, parent: { invocation: parent, declarationPosition: 0 }, work: { maxRounds: 1, execute: () => 'external result' } });
      await child.run();
      const relation = parent.children.get(child);
      const savedRef = checkpointReference({ identity: child.identity, target: { position: relation.declarationPosition }, round: relation.round, order: relation.order });
      parent.checkpointWriter.save('saved', { accepted: false }, { selected: savedRef });
      process.stdout.write(JSON.stringify(store.read(context.id)));
      // End the real process after durable capture and before parent acceptance.
      // No terminal-delivery record is produced in this process.
      process.exit(0);
    },
  },
});
const result = await invocation.run();
process.stdout.write(JSON.stringify({ result, head: store.read(context.id), restored: invocation.recovering }));
