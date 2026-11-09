import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore, checkpointSaveReceipt } from '@weiliang0121/capix-checkpoint';
import { Invocation, InvocationContext } from '@weiliang0121/capix-invocation';

const codec = { encode: (value) => value, decode: (value) => value };

function fixture({ save, finish, execute, observe, signal, valueCodec = codec, check } = {}) {
  const memory = new MemoryCheckpointStore();
  const writes = { save: 0, finish: 0 };
  const facts = [];
  const context = new InvocationContext('input');
  const store = {
    read: (id) => memory.read(id),
    save(image, revision) {
      writes.save++;
      return save ? save(memory, image, revision) : memory.save(image, revision);
    },
    finish(id, revision, delivery) {
      writes.finish++;
      return finish ? finish(memory, id, revision, delivery) : memory.finish(id, revision, delivery);
    },
  };
  const call = new Invocation({
    context,
    identity: { contextId: context.id, kind: 'node' },
    signal: signal ?? new AbortController().signal,
    checkpoints: {
      store,
      observation: {
        observe(fact) {
          facts.push(fact);
          observe?.(fact, call);
        },
      },
    },
    work: {
      checkpoint: {
        key: 'test.checkpoint-write-boundary',
        version: 1,
        input: valueCodec,
        output: valueCodec,
        points: { saved: { state: valueCodec, check, execute: () => assert.fail('not a resume test') } },
      },
      execute(_context, owner) {
        if (execute) return execute(owner);
        owner.checkpointWriter.save('saved', 'state');
        return 'output';
      },
    },
  });
  return { call, memory, writes, facts, head: () => memory.read(context.id) };
}

for (const mismatch of ['revision', 'foreign-image', 'same-id-different-body']) {
  test(`save rejects ${mismatch} acknowledgement without another write`, async () => {
    const probe = fixture({
      save(memory, image, revision) {
        const receipt = memory.save(image, revision);
        if (mismatch === 'revision') return { ...receipt, revision: receipt.revision + 1 };
        const changed = mismatch === 'foreign-image' ? { ...image, id: 'foreign-image' } : { ...image, state: 'different persisted body' };
        return checkpointSaveReceipt(changed, receipt.revision);
      },
    });
    await assert.rejects(probe.call.run());
    assert.deepEqual(probe.writes, { save: 1, finish: 0 });
    assert.equal(probe.head().revision, 1);
    assert.equal(probe.head().image.state, 'state');
    assert.equal(probe.head().delivery, undefined);
    assert.equal(
      probe.facts.some((fact) => fact.kind === 'saved'),
      false,
    );
  });
}

for (const mismatch of ['revision', 'status', 'same-status-different-output']) {
  test(`finish rejects ${mismatch} acknowledgement without rewriting an unknown commit`, async () => {
    const probe = fixture({
      finish(memory, id, revision, delivery) {
        if (mismatch === 'status') return memory.finish(id, revision, { status: 'failed' });
        if (mismatch === 'same-status-different-output') return memory.finish(id, revision, { ...delivery, output: 'wrong output' });
        const receipt = memory.finish(id, revision, delivery);
        return { ...receipt, revision: receipt.revision + 1 };
      },
    });
    await assert.rejects(probe.call.run());
    assert.deepEqual(probe.writes, { save: 1, finish: 1 });
    assert.equal(probe.head().revision, 2);
    assert.equal(
      probe.facts.some((fact) => fact.kind === 'finished'),
      false,
    );
    // The bad adapter may already have committed; rejection is not a rollback.
    assert.equal(probe.head().delivery.status, mismatch === 'status' ? 'failed' : 'succeeded');
  });
}

test('a later save with an invalid receipt cannot finalize using the preceding revision', async () => {
  const probe = fixture({
    save(memory, image, revision) {
      const receipt = memory.save(image, revision);
      return revision === 0 ? receipt : { ...receipt, digest: 'invalid' };
    },
    execute(owner) {
      owner.checkpointWriter.save('saved', 'first');
      owner.checkpointWriter.save('saved', 'second');
      assert.fail('unknown commit must stop business');
    },
  });
  await assert.rejects(probe.call.run());
  assert.deepEqual(probe.writes, { save: 2, finish: 0 });
  assert.equal(probe.head().revision, 2);
  assert.equal(probe.head().image.state, 'second');
  assert.equal(probe.head().delivery, undefined);
});

for (const boundary of ['save', 'finish']) {
  test(`a throwing ${boundary} adapter does not trigger a second write after a real commit`, async () => {
    const failure = new Error('acknowledgement lost');
    const probe = fixture({
      [boundary](memory, ...args) {
        memory[boundary](...args);
        throw failure;
      },
    });
    await assert.rejects(probe.call.run(), (error) => error === failure);
    assert.deepEqual(probe.writes, { save: 1, finish: boundary === 'finish' ? 1 : 0 });
    assert.equal(probe.head().revision, boundary === 'finish' ? 2 : 1);
  });
}

test('captured callback cannot reenter save even if it catches the local rejection', async () => {
  let nestedError;
  const probe = fixture({
    observe(fact, owner) {
      if (fact.kind !== 'captured') return;
      try {
        owner.checkpointWriter.save('saved', 'nested');
      } catch (error) {
        nestedError = error;
      }
    },
  });
  await assert.rejects(probe.call.run(), /cannot reenter/);
  assert.match(nestedError.message, /cannot reenter/);
  assert.deepEqual(probe.writes, { save: 0, finish: 0 });
  assert.equal(probe.head(), undefined);
});

test('cancellation during captured notification is checked before committing', async () => {
  const controller = new AbortController();
  const reason = new Error('stop before commit');
  const probe = fixture({
    signal: controller.signal,
    observe(fact) {
      if (fact.kind === 'captured') controller.abort(reason);
    },
  });
  await assert.rejects(probe.call.run(), { code: 'INVOCATION_CANCELLED' });
  assert.deepEqual(probe.writes, { save: 0, finish: 0 });
  assert.equal(probe.head(), undefined);
});

test('parent codec results are fixed before a shared scratch object is reused', async () => {
  const scratch = { value: '' };
  const valueCodec = {
    encode(value) {
      scratch.value = value;
      return scratch;
    },
    decode(saved) {
      return saved.value;
    },
  };
  const probe = fixture({ valueCodec });
  assert.equal(await probe.call.run(), 'output');
  const head = probe.head();
  assert.deepEqual(head.image.frame.input, { value: 'input' });
  assert.deepEqual(head.image.frame.currentInput, { value: 'input' });
  assert.deepEqual(head.image.state, { value: 'state' });
  assert.deepEqual(head.delivery.output, { value: 'output' });
  assert.deepEqual(head.delivery.progress.currentInput, { value: 'input' });
});

test('two ordinary saves each advance once and finalization confirms the last image', async () => {
  const probe = fixture({
    execute(owner) {
      owner.checkpointWriter.save('saved', 'first');
      owner.checkpointWriter.save('saved', 'second');
      return 'output';
    },
  });
  assert.equal(await probe.call.run(), 'output');
  assert.deepEqual(probe.writes, { save: 2, finish: 1 });
  assert.equal(probe.head().revision, 3);
  assert.equal(probe.head().image.state, 'second');
  assert.equal(probe.head().delivery.output, 'output');
  assert.deepEqual(
    probe.facts.filter((fact) => ['saved', 'finished'].includes(fact.kind)).map((fact) => fact.kind),
    ['saved', 'saved', 'finished'],
  );
});
