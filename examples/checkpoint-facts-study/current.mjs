import assert from 'node:assert/strict';
import { Invocation, InvocationContext } from '@weiliang0121/capix-invocation';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

const codec = { encode: (value) => value, decode: (value) => value };

// Characterize public, currently built packages. These are counterexamples to a
// proposed fixed-fact contract, not recommendations for mutating delivered values.
async function observeCurrent(checkpointsEnabled) {
  const memory = new MemoryCheckpointStore();
  const images = [];
  const writes = { save: 0, finish: 0 };
  const store = {
    read: (id) => memory.read(id),
    save(image, revision) {
      writes.save++;
      const receipt = memory.save(image, revision);
      images.push(image);
      return receipt;
    },
    finish(id, revision, delivery) {
      writes.finish++;
      return memory.finish(id, revision, delivery);
    },
  };
  const signal = new AbortController().signal;
  const input = { query: { text: 'at creation' } };
  const delivered = { detail: { text: 'at return' } };
  const accepted = { detail: { text: 'at acceptance' } };
  const childBinding = {
    key: 'study.fixed-facts.current.child',
    version: 1,
    input: codec,
    output: codec,
    points: {},
  };
  const context = new InvocationContext(input);
  let observed;
  const parent = new Invocation({
    context,
    signal,
    identity: { contextId: context.id, kind: 'group' },
    ...(checkpointsEnabled ? { checkpoints: { store } } : {}),
    work: {
      checkpoint: {
        key: 'study.fixed-facts.current.parent',
        version: 1,
        input: codec,
        output: codec,
        children: [{ kind: 'node', binding: childBinding }],
        points: { saved: { state: codec, execute: () => assert.fail('unexpected resume') } },
      },
      async execute(_context, invocation) {
        // Mutate before the first save, so this does not trigger Store's existing
        // original-input comparison and mask the independent output counterexample.
        input.query.text = 'changed after creation';
        assert.equal(invocation.context.input, input);
        assert.equal(invocation.context.currentInput.query.text, 'changed after creation');
        const childContext = new InvocationContext(null);
        const child = new Invocation({
          context: childContext,
          signal,
          identity: { contextId: childContext.id, parentContextId: context.id, kind: 'node' },
          parent: { invocation, declarationPosition: 0 },
          ...(checkpointsEnabled ? { checkpoints: { store } } : {}),
          work: { checkpoint: childBinding, execute: () => delivered },
        });
        assert.equal(await child.run(), delivered);
        const relation = invocation.children.get(child);
        assert.equal(await relation.accept(() => accepted), accepted);
        const returned = relation.returned;
        const reception = relation.reception;
        assert.ok(Object.isFrozen(returned));
        assert.ok(Object.isFrozen(reception));
        assert.equal(Object.isFrozen(delivered.detail), false);
        assert.equal(Object.isFrozen(accepted.detail), false);
        if (checkpointsEnabled) invocation.checkpointWriter.save('saved', null);

        delivered.detail.text = 'changed after return';
        accepted.detail.text = 'changed after acceptance';
        assert.equal(relation.returned, returned);
        assert.equal(relation.reception, reception);
        assert.equal(returned.output.detail.text, 'changed after return');
        assert.equal(reception.output.detail.text, 'changed after acceptance');
        if (checkpointsEnabled) invocation.checkpointWriter.save('saved', null);

        // The child declares CP and (in the enabled case) has an installed Store,
        // but never saves. A successful return does not establish a durable head.
        assert.equal(memory.read(childContext.id), undefined);
        observed = {
          checkpointsEnabled,
          inputAfterAliasMutation: invocation.context.input.query.text,
          returnedAfterAliasMutation: returned.output.detail.text,
          acceptedAfterAliasMutation: reception.output.detail.text,
          childReturned: returned.status,
          childSavedHead: false,
        };
        return 'finished';
      },
    },
  });
  assert.equal(await parent.run(), 'finished');
  assert.deepEqual(writes, checkpointsEnabled ? { save: 2, finish: 1 } : { save: 0, finish: 0 });
  const snapshots = images.map((image) => {
    const state = image.frame.children[0].state;
    assert.equal(state.kind, 'returned');
    assert.equal(state.reception.kind, 'accepted');
    return { returned: state.output.detail.text, accepted: state.reception.output.detail.text };
  });
  assert.deepEqual(
    snapshots,
    checkpointsEnabled
      ? [
          { returned: 'at return', accepted: 'at acceptance' },
          { returned: 'changed after return', accepted: 'changed after acceptance' },
        ]
      : [],
  );
  return { ...observed, writes, snapshots };
}

export async function characterizeCurrent() {
  return [await observeCurrent(false), await observeCurrent(true)];
}
