import assert from 'node:assert/strict';

import { test } from 'node:test';

import { stableValue, StableValueError } from '@weiliang0121/capix-contracts';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

import { Invocation, InvocationContext, InvocationObservation, ObserverSession, InvocationCancelled } from '@weiliang0121/capix-invocation';

const codec = { encode: (value) => value, decode: (value) => value };

const reception = { position: 0, childPosition: 0, check() {}, codec };

const childBinding = {
  key: 'test.stable.child',
  version: 1,
  input: codec,
  output: codec,
  points: {
    ready: {
      state: codec,
      execute() {
        assert.fail('unexpected restore');
      },
    },
  },
};

const parentBinding = {
  key: 'test.stable.parent',
  version: 1,
  input: codec,
  output: codec,
  children: [{ kind: 'node', binding: childBinding }],
  receptions: [reception],
  points: {
    ready: {
      state: codec,
      execute() {
        assert.fail('unexpected restore');
      },
    },
  },
};

function invocation({ input = null, parent, execute, close, binding, store, signal = parent?.context.signal ?? new AbortController().signal, receiveFailure = false, observe }) {
  const context = new InvocationContext(input);
  return new Invocation({
    context,
    signal,
    identity: { contextId: context.id, kind: parent ? 'node' : 'group', ...(parent ? { parentContextId: parent.context.id } : {}) },
    ...(parent ? { parent: { invocation: parent, declarationPosition: 0, receiveFailure } } : {}),
    ...(observe ? { observation: new InvocationObservation([new ObserverSession({ observe }, 'propagate')], new Map()) } : {}),
    ...(store ? { checkpoints: { store } } : {}),
    work: { execute, ...(close ? { close } : {}), ...(binding ? { checkpoint: binding } : {}) },
  });
}

for (const enabled of [false, true]) {
  test(`stable invocation facts are established with CP ${enabled ? 'enabled' : 'disabled'}`, async () => {
    const store = enabled ? new MemoryCheckpointStore() : undefined;
    const rawInput = { query: { text: 'initial' } };
    const rawOutput = { words: ['hello'] };
    const rawAccepted = { translated: ['你好'] };
    const images = [];
    let child;
    let relation;
    let accepted;
    const root = invocation({
      input: rawInput,
      binding: parentBinding,
      store,
      async execute(context, parent) {
        assert.notEqual(context.input, rawInput);
        assert.equal(context.input.query.text, 'initial');
        assert.throws(() => {
          context.input.query.text = 'mutation';
        }, TypeError);
        child = invocation({
          input: context.input,
          parent,
          binding: childBinding,
          store,
          execute(_context, call) {
            if (enabled) call.checkpointWriter.save('ready', null);
            return rawOutput;
          },
          close() {
            rawOutput.words[0] = 'changed during Work.close';
            return { status: 'succeeded', value: undefined };
          },
        });
        assert.equal(child.context.input, context.input, 'trusted forwarding keeps one stable value');
        const returned = await child.run();
        relation = parent.children.get(child);
        assert.deepEqual(returned, { words: ['hello'] });
        assert.equal(returned, child.context.state.output);
        assert.equal(returned, relation.returned.output);
        accepted = await relation.accept((value) => {
          assert.equal(value, returned);
          assert.throws(() => value.words.push('mutation'), TypeError);
          return rawAccepted;
        }, reception);
        assert.notEqual(accepted, rawAccepted);
        if (enabled) {
          parent.checkpointWriter.save('ready', null);
          images.push(store.read(parent.context.id).image);
        }
        rawOutput.words[0] = 'changed after return';
        rawAccepted.translated[0] = 'changed after acceptance';
        if (enabled) {
          parent.checkpointWriter.save('ready', null);
          images.push(store.read(parent.context.id).image);
        }
        return accepted;
      },
    });
    rawInput.query.text = 'changed before run';
    const result = await root.run();
    assert.equal(result, accepted);
    assert.equal(result, relation.reception.output);
    assert.deepEqual(result, { translated: ['你好'] });
    assert.equal(stableValue(result), result);
    for (const image of images) {
      assert.equal(image.frame.input.query.text, 'initial');
      assert.deepEqual(image.frame.children[0].state.output, { words: ['hello'] });
      assert.deepEqual(image.frame.children[0].state.reception.output, { translated: ['你好'] });
    }
    assert.equal(store?.read(root.context.id)?.delivery?.status, enabled ? 'succeeded' : undefined);
  });
}

test('unsupported input is rejected at the low-level Context boundary', () => {
  assert.throws(() => new InvocationContext({ operation() {} }), StableValueError);
  assert.throws(() => new InvocationContext(new Date()), StableValueError);
});

test('body fixing failure remains protected and still closes Work', async () => {
  let closed = 0;
  let fallback = 0;
  let relation;
  const root = invocation({
    async execute(_context, parent) {
      const child = invocation({
        parent,
        receiveFailure: true,
        execute: () => new Date(),
        close() {
          closed++;
          return { status: 'succeeded', value: undefined };
        },
      });
      await assert.rejects(child.run(), StableValueError);
      relation = parent.children.get(child);
      await assert.rejects(
        relation.handle(() => {
          fallback++;
          return 'fallback';
        }),
      );
      return null;
    },
  });
  await assert.rejects(root.run(), StableValueError);
  assert.equal(closed, 1);
  assert.equal(fallback, 0);
  assert.equal(relation.returned.status, 'failed');
  assert.equal(relation.returned.failure.receptionAllowed, false);
});

test('Proxy throwing undefined while fixing remains a protected failure, not a missing outcome', async () => {
  let closed = 0;
  const call = invocation({
    execute: () =>
      new Proxy(
        {},
        {
          ownKeys() {
            throw undefined;
          },
        },
      ),
    close() {
      closed++;
      return { status: 'succeeded', value: undefined };
    },
  });
  await assert.rejects(call.run(), StableValueError);
  assert.equal(closed, 1);
  assert.equal(call.context.status, 'failed');
});

test('body fixing failure is owned only after already-entered receptions drain', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let relation;
  let accepted;
  const root = invocation({
    async execute(_context, parent) {
      const child = invocation({ parent, execute: () => 'child' });
      await child.run();
      relation = parent.children.get(child);
      accepted = relation.accept(async () => {
        entered.resolve();
        await release.promise;
        parent.requireActive();
        return { completed: true };
      });
      return new Date();
    },
  });
  const pending = root.run();
  await entered.promise;
  release.resolve();
  await assert.rejects(pending, StableValueError);
  assert.deepEqual(await accepted, { completed: true });
  assert.equal(relation.reception.status, 'accepted');
  assert.equal(root.context.status, 'failed');
});

test('reception fixes before check and a fixing failure does not install acceptance', async () => {
  let checked = 0;
  let relation;
  const contract = {
    ...reception,
    check() {
      checked++;
    },
  };
  const root = invocation({
    async execute(_context, parent) {
      const child = invocation({ parent, execute: () => ({ value: 1 }) });
      await child.run();
      relation = parent.children.get(child);
      await assert.rejects(
        relation.accept(() => new Date(), contract),
        StableValueError,
      );
      return null;
    },
  });
  await assert.rejects(root.run(), StableValueError);
  assert.equal(checked, 0);
  assert.equal(relation.returned.status, 'succeeded');
  assert.equal(relation.reception.status, 'failed');
  assert.equal(relation.reception.failure.receptionAllowed, false);
});

test('successful reception checks see stable values and cannot replace them', async () => {
  const raw = { items: [1] };
  let checked;
  const contract = {
    ...reception,
    check(value) {
      checked = value;
      assert.notEqual(value, raw);
      assert.throws(() => value.items.push(2), TypeError);
      return { replacement: true };
    },
  };
  const root = invocation({
    async execute(_context, parent) {
      const child = invocation({ parent, execute: () => 'child' });
      await child.run();
      return parent.children.get(child).accept(() => raw, contract);
    },
  });
  assert.equal(await root.run(), checked);
  assert.deepEqual(checked, { items: [1] });
});

for (const check of [
  () => {
    throw new Error('invalid reception');
  },
  () => Promise.resolve(),
]) {
  test(`reception ${check.toString().includes('Promise') ? 'async' : 'failed'} check stays protected`, async () => {
    let relation;
    const root = invocation({
      async execute(_context, parent) {
        const child = invocation({ parent, execute: () => 'child' });
        await child.run();
        relation = parent.children.get(child);
        await assert.rejects(
          relation.accept(() => ({ valid: false }), { ...reception, check }),
          /violates its contract/,
        );
        return null;
      },
    });
    await assert.rejects(root.run(), /violates its contract/);
    assert.equal(relation.reception.status, 'failed');
    assert.equal(relation.reception.failure.receptionAllowed, false);
  });
}

test('handled failure preserves the thrown Error and fixes its diagnostic before later mutation', async () => {
  const failure = new Error('original failure');
  const fallback = { value: 'handled' };
  let child;
  let relation;
  const root = invocation({
    async execute(_context, parent) {
      child = invocation({
        parent,
        receiveFailure: true,
        execute() {
          throw failure;
        },
      });
      await assert.rejects(child.run(), (error) => error === failure);
      relation = parent.children.get(child);
      failure.message = 'changed after failed delivery';
      assert.equal(relation.returned.error, failure);
      assert.equal(relation.returned.diagnostic.message, 'original failure');
      assert.equal(child.context.state.error, failure);
      assert.equal(child.context.state.diagnostic.message, 'original failure');
      const accepted = await relation.handle((error) => {
        assert.equal(error, failure);
        return fallback;
      });
      fallback.value = 'changed after handling';
      assert.equal(relation.returned.status, 'failed');
      return accepted;
    },
  });
  assert.deepEqual(await root.run(), { value: 'handled' });
  assert.equal(relation.reception.status, 'handled');
  assert.equal(child.context.status, 'failed');
});

test('strict accepted observation failure does not roll back the stable acceptance', async () => {
  const failure = new Error('accepted observation failed');
  const raw = { accepted: ['value'] };
  let relation;
  const root = invocation({
    observe(fact) {
      if (fact.kind === 'relation' && fact.change.kind === 'accepted') throw failure;
    },
    async execute(_context, parent) {
      const child = invocation({ parent, execute: () => 'child' });
      await child.run();
      relation = parent.children.get(child);
      await assert.rejects(relation.accept(() => raw));
      raw.accepted[0] = 'changed';
      assert.equal(relation.reception.status, 'accepted');
      assert.deepEqual(relation.reception.output, { accepted: ['value'] });
      return null;
    },
  });
  await assert.rejects(root.run());
  assert.equal(relation.reception.status, 'accepted');
});

test('an entered local reception may finish after cancellation without reviving the parent', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let relation;
  const raw = { local: ['completed'] };
  const root = invocation({
    signal: controller.signal,
    async execute(_context, parent) {
      const child = invocation({ parent, execute: () => 'child' });
      await child.run();
      relation = parent.children.get(child);
      return relation.accept(async () => {
        entered.resolve();
        await release.promise;
        return raw;
      });
    },
  });
  const pending = root.run();
  await entered.promise;
  controller.abort(new Error('cancel parent'));
  release.resolve();
  await assert.rejects(pending, InvocationCancelled);
  assert.equal(relation.reception.status, 'accepted');
  raw.local[0] = 'changed';
  assert.deepEqual(relation.reception.output, { local: ['completed'] });
  assert.equal(root.context.status, 'failed');
});

test('finish committed then lost acknowledgement keeps stable work and durable success apart from failed parent delivery', async () => {
  const memory = new MemoryCheckpointStore();
  const receiptFailure = new Error('finish acknowledgement lost');
  let target;
  let finishes = 0;
  const store = {
    read: (id) => memory.read(id),
    save: (image, revision) => memory.save(image, revision),
    finish(id, revision, delivery) {
      finishes++;
      const receipt = memory.finish(id, revision, delivery);
      if (id === target.context.id) throw receiptFailure;
      return receipt;
    },
  };
  const raw = { value: ['durable'] };
  let relation;
  const root = invocation({
    async execute(_context, parent) {
      target = invocation({
        parent,
        binding: childBinding,
        store,
        execute(_childContext, child) {
          child.checkpointWriter.save('ready', null);
          return raw;
        },
      });
      await assert.rejects(target.run(), (error) => error === receiptFailure);
      relation = parent.children.get(target);
      return null;
    },
  });
  await assert.rejects(root.run(), (error) => error === receiptFailure);
  raw.value[0] = 'changed';
  assert.equal(target.context.status, 'succeeded');
  assert.deepEqual(target.context.state.output, { value: ['durable'] });
  assert.equal(memory.read(target.context.id).delivery.status, 'succeeded');
  assert.equal(relation.returned.status, 'failed');
  assert.equal(finishes, 1, 'uncertain finish cannot be overwritten with a failed delivery');
});
