import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Invocation, InvocationContext } from '@weiliang0121/capix-invocation';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

const codec = { encode: (value) => value, decode: (value) => value };

// Migrated characterization: facts are established before persistence. Old source
// references and stateful codecs cannot rewrite their published representation.
function parentFixture({ input = null, execute, check, childBinding, restored, resume } = {}) {
  const memory = new MemoryCheckpointStore();
  const images = [];
  const writes = { save: 0, finish: 0 };
  if (restored) memory.save(restored, 0);
  const context = new InvocationContext(input);
  if (restored) context.installCheckpoint({ id: restored.frame.owner.contextId, round: restored.frame.round, currentInput: restored.frame.currentInput });
  const signal = new AbortController().signal;
  const store = {
    read: (id) => memory.read(id),
    save(image, revision) {
      writes.save++;
      const receipt = memory.save(image, revision);
      images.push(memory.read(receipt.contextId).image);
      return receipt;
    },
    finish(id, revision, delivery) {
      writes.finish++;
      return memory.finish(id, revision, delivery);
    },
  };
  const call = new Invocation({
    context,
    signal,
    identity: { contextId: context.id, kind: 'group' },
    checkpoints: { store },
    ...(restored ? { restore: { head: memory.read(context.id) } } : {}),
    work: {
      checkpoint: {
        key: 'test.checkpoint-reuse-boundaries',
        version: 1,
        input: codec,
        output: codec,
        children: [{ kind: 'node', ...(childBinding ? { binding: childBinding } : {}) }],
        points: { saved: { state: codec, check, execute: resume ?? (() => assert.fail('unexpected resume')) } },
      },
      execute: (_context, invocation) => execute(invocation, signal),
    },
  });
  return { call, images, writes, head: () => memory.read(context.id) };
}

function childInvocation(parent, signal, output, binding) {
  const context = new InvocationContext(null);
  return new Invocation({
    context,
    signal,
    identity: { contextId: context.id, parentContextId: parent.context.id, kind: 'node' },
    parent: { invocation: parent, declarationPosition: 0 },
    work: { ...(binding ? { checkpoint: { ...binding, points: {} } } : {}), execute: () => output },
  });
}

test('stable returned/reception facts isolate later mutations of original source objects', async () => {
  const delivered = { detail: { text: 'returned before' } };
  const accepted = { detail: { text: 'accepted before' } };
  const probe = parentFixture({
    async execute(parent, signal) {
      const child = childInvocation(parent, signal, delivered);
      await child.run();
      const relation = parent.children.get(child);
      assert.deepEqual(await relation.accept(() => accepted), accepted);
      parent.checkpointWriter.save('saved', null);
      const first = probe.images.at(-1);
      const returned = relation.returned;
      const reception = relation.reception;
      assert.ok(Object.isFrozen(returned));
      assert.ok(Object.isFrozen(reception));
      assert.equal(Object.isFrozen(delivered.detail), false);
      assert.equal(Object.isFrozen(accepted.detail), false);

      delivered.detail.text = 'returned after';
      accepted.detail.text = 'accepted after';
      parent.checkpointWriter.save('saved', null);
      const second = probe.images.at(-1);
      assert.equal(relation.returned, returned);
      assert.equal(relation.reception, reception);

      assert.deepEqual(second.frame.children[0], first.frame.children[0]);
      return 'finished';
    },
  });
  assert.equal(await probe.call.run(), 'finished');
  const first = probe.images[0].frame.children[0].state;
  const second = probe.images[1].frame.children[0].state;
  assert.equal(first.output.detail.text, 'returned before');
  assert.equal(first.reception.output.detail.text, 'accepted before');
  assert.equal(second.output.detail.text, 'returned before');
  assert.equal(second.reception.output.detail.text, 'accepted before');
  assert.deepEqual(probe.writes, { save: 2, finish: 1 });
});

test('later changes to the caller input cannot change the fixed invocation input', async () => {
  const input = { query: { text: 'original' } };
  const probe = parentFixture({
    input,
    execute(parent) {
      parent.checkpointWriter.save('saved', null);
      input.query.text = 'changed';
      assert.notEqual(parent.context.input, input);
      assert.equal(parent.context.input.query.text, 'original');
      parent.checkpointWriter.save('saved', null);
      return 'done';
    },
  });
  assert.equal(await probe.call.run(), 'done');
  assert.equal(probe.head().image.frame.input.query.text, 'original');
  assert.equal(probe.head().revision, 3);
  assert.equal(probe.head().delivery.status, 'succeeded');
  assert.deepEqual(probe.writes, { save: 2, finish: 1 });
});

test('first checkpoint consumes the child value fixed before later source mutation', async () => {
  const delivered = { text: 'at return' };
  const probe = parentFixture({
    async execute(parent, signal) {
      const child = childInvocation(parent, signal, delivered);
      assert.deepEqual(await child.run(), delivered);
      const returned = parent.children.get(child).returned;
      assert.equal(returned.output.text, 'at return');
      delivered.text = 'before first save';
      parent.checkpointWriter.save('saved', null);
      assert.equal(parent.children.get(child).returned, returned);
      return 'finished';
    },
  });
  assert.equal(await probe.call.run(), 'finished');
  assert.equal(probe.images[0].frame.children[0].state.output.text, 'at return');
});

test('a Date codec cannot bypass the ordinary-data delivery boundary', async () => {
  let encodes = 0;
  const childBinding = {
    key: 'date',
    version: 1,
    input: codec,
    output: {
      encode(value) {
        encodes++;
        return value.toISOString();
      },
      decode: (value) => new Date(value),
    },
  };
  const probe = parentFixture({
    childBinding,
    async execute(parent, signal) {
      await childInvocation(parent, signal, new Date(), childBinding).run();
      parent.checkpointWriter.save('saved', null);
    },
  });
  await assert.rejects(probe.call.run(), /ordinary data/);
  assert.equal(encodes, 0);
  assert.equal(probe.images.length, 0);
});

test('lossy decoding is rejected at the first publication instead of changing a recovered value', async () => {
  const childBinding = { key: 'normalization', version: 1, input: codec, output: { encode: (value) => value, decode: (value) => value.trim() } };
  const probe = parentFixture({
    childBinding,
    async execute(parent, signal) {
      await childInvocation(parent, signal, '  original  ', childBinding).run();
      parent.checkpointWriter.save('saved', null);
      return 'done';
    },
  });
  await assert.rejects(probe.call.run(), /preserve the established value/);
  assert.equal(probe.images.length, 0);
});

test('the first published representation remains fixed even when a codec closure changes later', async () => {
  const delivered = Object.freeze({ text: 'fixed output' });
  let encodingEpoch = 1;
  const childBinding = {
    key: 'test.checkpoint-reuse-codec-closure',
    version: 1,
    input: codec,
    // Deliberately stateful to test the existing interface boundary; this is not
    // a recommended codec. Freezing its input cannot make this closure pure.
    output: Object.freeze({
      encode: (value) => ({ text: value.text, epoch: encodingEpoch }),
      decode: (saved) => Object.freeze({ text: saved.text }),
    }),
  };
  const probe = parentFixture({
    input: Object.freeze({ request: 'fixed input' }),
    childBinding,
    async execute(parent, signal) {
      const child = childInvocation(parent, signal, delivered, childBinding);
      assert.deepEqual(await child.run(), delivered);
      const relation = parent.children.get(child);
      const returned = relation.returned;
      const reception = relation.reception;
      parent.checkpointWriter.save('saved', null);
      encodingEpoch = 2;
      parent.checkpointWriter.save('saved', null);
      assert.equal(relation.returned, returned);
      assert.equal(relation.reception, reception);
      assert.deepEqual(relation.returned.output, delivered);
      assert.ok(Object.isFrozen(delivered));
      assert.ok(Object.isFrozen(parent.context.input));
      return 'finished';
    },
  });
  assert.equal(await probe.call.run(), 'finished');
  assert.deepEqual(
    probe.images.map((image) => image.frame.children[0].state.output),
    [
      { text: 'fixed output', epoch: 1 },
      { text: 'fixed output', epoch: 1 },
    ],
  );
  assert.deepEqual(probe.images[0].frame.input, probe.images[1].frame.input);
  assert.deepEqual(probe.writes, { save: 2, finish: 1 });
});
