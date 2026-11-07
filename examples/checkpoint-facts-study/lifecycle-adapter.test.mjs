import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationCancelled } from '@capix/invocation';
import { LifecycleAdapter } from './lifecycle-adapter.mjs';
import { lifecycleBinding, lifecycleReception } from './invocation-lifecycle.mjs';

function setup(t, options = {}) {
  const adapter = new LifecycleAdapter(options);
  t.after(() => adapter.close());
  return adapter;
}

function declarations(reception = lifecycleReception()) {
  const child = lifecycleBinding('study.adapter.child');
  const parent = lifecycleBinding('study.adapter.parent', { children: [{ kind: 'node', binding: child }], receptions: [reception] });
  return { child, parent, reception };
}

function save(invocation, label) {
  return invocation.checkpointWriter.save('checkpoint', { label });
}

function images(adapter, invocation) {
  return adapter.snapshots.filter((image) => image.frame.owner.contextId === invocation.context.id);
}

test('adapter reconstructs waiting, returned, receiving and accepted without using the oracle Frame as input', async (t) => {
  const adapter = setup(t);
  const bindings = declarations();
  let child;
  const root = adapter.create({
    input: { task: 'read' },
    binding: bindings.parent,
    async execute(_context, invocation) {
      child = adapter.create({
        parent: invocation,
        key: 'read',
        input: { path: 'notes' },
        binding: bindings.child,
        execute(_childContext, childInvocation) {
          save(childInvocation, 'child-prepared');
          return { text: 'body' };
        },
      });
      const relation = invocation.children.get(child);
      save(invocation, 'waiting');
      await child.run();
      save(invocation, 'returned');
      const value = await relation.accept((delivered) => {
        save(invocation, 'receiving');
        return { text: delivered.text.toUpperCase() };
      }, bindings.reception);
      save(invocation, 'accepted');
      return value;
    },
  });
  assert.deepEqual(await root.run(), { text: 'BODY' });
  const snapshots = images(adapter, root);
  assert.deepEqual(
    snapshots.map((image) => image.state.label),
    ['waiting', 'returned', 'receiving', 'accepted'],
  );
  assert.deepEqual(
    snapshots.map((image) => image.frame.children[0].state.kind),
    ['waiting', 'returned', 'returned', 'returned'],
  );
  assert.deepEqual(
    snapshots.slice(1).map((image) => image.frame.children[0].state.reception.kind),
    ['pending', 'receiving', 'accepted'],
  );
  assert.ok(adapter.comparisons.length >= 5);
  for (const snapshot of snapshots) {
    const relation = snapshot.frame.children[0];
    assert.equal(snapshot.formatVersion, 5);
    assert.equal(snapshot.frame.nextChildOrder, 1);
    assert.equal(relation.order, 0);
    assert.equal(relation.round, 1);
    assert.deepEqual(relation.identity, child.identity);
    assert.deepEqual(relation.input, { path: 'notes' });
    assert.deepEqual(relation.target, { position: 0 });
  }
  assert.deepEqual(adapter.models.get(root.context.id).readHead(), adapter.store.read(root.context.id));
});

test('same key and declaration keep distinct zero-based orders and typed reception outputs', async (t) => {
  const reception = {
    position: 0,
    childPosition: 0,
    codec: { encode: (value) => ({ encoded: value.received }), decode: (value) => ({ received: value.encoded }) },
    check: (value) => assert.equal(typeof value.received, 'string'),
  };
  const bindings = declarations(reception);
  const adapter = setup(t);
  const children = [];
  const root = adapter.create({
    binding: bindings.parent,
    async execute(_context, invocation) {
      for (const text of ['first', 'second']) {
        const child = adapter.create({ parent: invocation, key: 'repeated', input: { text }, binding: bindings.child, execute: () => ({ text }) });
        children.push(child);
        await child.run();
        await invocation.children.get(child).accept((value) => ({ received: value.text }), reception);
        save(invocation, text);
      }
      return 'done';
    },
  });
  assert.equal(await root.run(), 'done');
  const frame = images(adapter, root).at(-1).frame;
  assert.equal(frame.nextChildOrder, 2);
  assert.deepEqual(
    frame.children.map((child) => child.order),
    [0, 1],
  );
  assert.deepEqual(
    frame.children.map((child) => child.key),
    ['repeated', 'repeated'],
  );
  assert.deepEqual(
    frame.children.map((child) => child.identity.contextId),
    children.map((child) => child.context.id),
  );
  assert.deepEqual(
    frame.children.map((child) => child.state.reception.output),
    [{ encoded: 'first' }, { encoded: 'second' }],
  );
  assert.deepEqual(
    frame.children.map((child) => child.state.reception.contract),
    [{ position: 0 }, { position: 0 }],
  );
});

test('deterministic non-identity input/output codecs reconstruct the actual wire Frame and final delivery', async (t) => {
  const adapter = setup(t);
  const childBinding = {
    ...lifecycleBinding('study.adapter.encoded-child'),
    input: { encode: (value) => ({ wireInput: value.text }), decode: (value) => ({ text: value.wireInput }) },
    output: { encode: (value) => ({ wireOutput: value.text }), decode: (value) => ({ text: value.wireOutput }) },
  };
  const reception = {
    ...lifecycleReception(),
    codec: { encode: (value) => ({ wireChoice: value.chosen }), decode: (value) => ({ chosen: value.wireChoice }) },
    check: (value) => assert.equal(value.chosen, 'REQUEST'),
  };
  const parentBinding = {
    ...lifecycleBinding('study.adapter.encoded-parent', { children: [{ kind: 'node', binding: childBinding }], receptions: [reception] }),
    input: { encode: (value) => ({ wirePrompt: value.prompt }), decode: (value) => ({ prompt: value.wirePrompt }) },
    output: { encode: (value) => ({ wireAnswer: value.answer }), decode: (value) => ({ answer: value.wireAnswer }) },
  };
  let child;
  const root = adapter.create({
    input: { prompt: 'request' },
    binding: parentBinding,
    async execute(context, invocation) {
      child = adapter.create({
        parent: invocation,
        binding: childBinding,
        input: { text: context.input.prompt },
        execute(childContext, childInvocation) {
          save(childInvocation, 'child-prepared');
          return { text: childContext.input.text.toUpperCase() };
        },
      });
      save(invocation, 'waiting');
      assert.deepEqual(await child.run(), { text: 'REQUEST' }, 'Business delivery remains decoded');
      const received = await invocation.children.get(child).accept((value) => ({ chosen: value.text }), reception);
      save(invocation, 'accepted');
      return { answer: received.chosen };
    },
  });
  assert.deepEqual(await root.run(), { answer: 'REQUEST' });
  const frame = images(adapter, root).at(-1).frame;
  assert.deepEqual(frame.input, { wirePrompt: 'request' });
  assert.deepEqual(frame.currentInput, { wirePrompt: 'request' });
  assert.deepEqual(frame.children[0].input, { wireInput: 'request' });
  assert.deepEqual(frame.children[0].state.output, { wireOutput: 'REQUEST' });
  assert.deepEqual(frame.children[0].state.progress.currentInput, { wireInput: 'request' });
  assert.deepEqual(frame.children[0].state.reception.output, { wireChoice: 'REQUEST' });
  assert.deepEqual(adapter.store.read(child.context.id).delivery.output, { wireOutput: 'REQUEST' });
  assert.deepEqual(adapter.store.read(root.context.id).delivery.output, { wireAnswer: 'REQUEST' });
});

test('repeated save does not rewrite old boundary rows; a newly selected state remains explicit', async (t) => {
  const adapter = setup(t);
  const root = adapter.create({
    input: { fixed: 'material' },
    binding: lifecycleBinding('study.adapter.repeated'),
    execute(_context, invocation) {
      save(invocation, 'first');
      const before = adapter.facts.db.prepare('SELECT id,body FROM facts').all();
      const written = adapter.facts.stats.factsWritten;
      const model = adapter.models.get(invocation.context.id);
      const previousEncodings = model.encodingCounts();
      save(invocation, 'second');
      const after = new Map(
        adapter.facts.db
          .prepare('SELECT id,body FROM facts')
          .all()
          .map((row) => [row.id, row.body]),
      );
      for (const row of before) assert.equal(after.get(row.id), row.body);
      for (const [id, count] of previousEncodings) assert.equal(model.encodingCounts().get(id), count, 'An already fixed boundary is not encoded again');
      assert.ok(adapter.facts.stats.factsWritten > written, 'The newly selected state/baseline is still represented');
      return 'done';
    },
  });
  assert.equal(await root.run(), 'done');
  assert.deepEqual(
    images(adapter, root).map((image) => image.state.label),
    ['first', 'second'],
  );
});

test('handled business failure preserves child failed return and parent replacement independently', async (t) => {
  const adapter = setup(t);
  const bindings = declarations();
  const failure = new Error('tool unavailable');
  let child;
  let relation;
  const root = adapter.create({
    binding: bindings.parent,
    async execute(_context, invocation) {
      child = adapter.create({
        parent: invocation,
        receiveFailure: true,
        binding: bindings.child,
        execute(_childContext, childInvocation) {
          save(childInvocation, 'child-prepared');
          throw failure;
        },
      });
      relation = invocation.children.get(child);
      save(invocation, 'waiting');
      await assert.rejects(child.run(), (error) => error === failure);
      const fallback = await relation.handle(() => ({ fallback: true }), bindings.reception);
      save(invocation, 'handled');
      return fallback;
    },
  });
  assert.deepEqual(await root.run(), { fallback: true });
  assert.equal(child.context.status, 'failed');
  assert.equal(adapter.store.read(child.context.id).delivery.status, 'failed');
  assert.equal(relation.returned.status, 'failed');
  assert.equal(relation.reception.status, 'handled');
  const saved = images(adapter, root).at(-1).frame.children[0];
  assert.equal(saved.state.kind, 'failed');
  assert.equal(saved.state.reception.kind, 'handled');
  assert.deepEqual(saved.state.reception.output, { fallback: true });
});

for (const failureStage of ['receiving-observation', 'callback', 'reception-check']) {
  test(`current ${failureStage} failure is recordable but cannot replace the last eligible Frame`, async (t) => {
    const adapter = setup(t);
    const failure = new Error(`failure at ${failureStage}`);
    const reception = {
      ...lifecycleReception(),
      check: () => {
        if (failureStage === 'reception-check') throw failure;
      },
    };
    const bindings = declarations(reception);
    let relation;
    let callbacks = 0;
    let before;
    const root = adapter.create({
      binding: bindings.parent,
      observe: (fact) => {
        if (failureStage === 'receiving-observation' && fact.kind === 'relation' && fact.change.kind === 'receiving') throw failure;
      },
      async execute(_context, invocation) {
        const child = adapter.create({ parent: invocation, binding: bindings.child, execute: () => 'child-result' });
        relation = invocation.children.get(child);
        await child.run();
        save(invocation, 'returned');
        before = adapter.store.read(invocation.context.id).image;
        await assert.rejects(
          relation.accept(() => {
            callbacks++;
            if (failureStage === 'callback') throw failure;
            return 'accepted';
          }, reception),
        );
        assert.equal(relation.returned.status, 'succeeded');
        assert.equal(relation.reception.status, 'failed');
        assert.throws(() => adapter.models.get(invocation.context.id).projectFrame());
        assert.throws(() => save(invocation, 'invalid-reception'));
        assert.deepEqual(adapter.store.read(invocation.context.id).image, before);
        throw failure;
      },
    });
    await assert.rejects(root.run());
    assert.equal(callbacks, failureStage === 'receiving-observation' ? 0 : 1);
    assert.equal(relation.returned.status, 'succeeded');
    assert.equal(relation.reception.status, 'failed');
    assert.equal(adapter.models.get(root.context.id).relation(relation.invocation.context.id).reception.status, 'failed');
    assert.equal(images(adapter, root).length, 1);
    assert.deepEqual(adapter.store.read(root.context.id).image, before);
  });
}

test('accepted observation failure cannot roll back acceptance or invent a newly saved parent image', async (t) => {
  const adapter = setup(t);
  const bindings = declarations();
  const failure = new Error('accepted observer failed');
  let relation;
  const root = adapter.create({
    binding: bindings.parent,
    observe: (fact) => {
      if (fact.kind === 'relation' && fact.change.kind === 'accepted') throw failure;
    },
    async execute(_context, invocation) {
      const child = adapter.create({ parent: invocation, binding: bindings.child, execute: () => ({ delivered: true }) });
      relation = invocation.children.get(child);
      await child.run();
      save(invocation, 'returned');
      return relation.accept(() => ({ accepted: true }), bindings.reception);
    },
  });
  await assert.rejects(root.run(), (error) => error.cause === failure);
  assert.equal(relation.returned.status, 'succeeded');
  assert.equal(relation.reception.status, 'accepted');
  assert.deepEqual(relation.reception.output, { accepted: true });
  const fixed = adapter.models.get(root.context.id).inspect();
  assert.equal(fixed.relations[0].reception.status, 'accepted');
  assert.deepEqual(fixed.relations[0].reception.output, { accepted: true });
  assert.equal(root.context.status, 'failed');
  assert.equal(adapter.store.read(root.context.id).delivery.status, 'failed');
  assert.equal(adapter.store.read(root.context.id).image.frame.children[0].state.reception.kind, 'pending');
  assert.equal(images(adapter, root).length, 1);
});

test('lost child finish acknowledgement preserves successful work and durable delivery but failed parent return', async (t) => {
  const failure = new Error('child finish receipt lost');
  let child;
  let relation;
  let bodyCalls = 0;
  const adapter = setup(t, {
    afterFinish: (id) => {
      if (id === child?.context.id) throw failure;
    },
  });
  const bindings = declarations();
  const root = adapter.create({
    binding: bindings.parent,
    async execute(_context, invocation) {
      child = adapter.create({
        parent: invocation,
        receiveFailure: true,
        binding: bindings.child,
        execute(_childContext, childInvocation) {
          bodyCalls++;
          save(childInvocation, 'prepared');
          return { completed: true };
        },
      });
      relation = invocation.children.get(child);
      save(invocation, 'waiting');
      await child.run();
      assert.fail('The parent must not receive successful delivery after the receipt was lost');
    },
  });
  await assert.rejects(root.run(), (error) => error === failure);
  assert.equal(bodyCalls, 1);
  assert.equal(child.context.status, 'succeeded');
  assert.equal(adapter.store.read(child.context.id).delivery.status, 'succeeded');
  assert.equal(relation.returned.status, 'failed');
  assert.equal(relation.returned.failure.receptionAllowed, false);
  assert.equal(relation.reception.status, 'pending');
  const fixedChild = adapter.models.get(child.context.id).inspect();
  const fixedParent = adapter.models.get(root.context.id).inspect();
  assert.equal(fixedChild.workTerminal.status, 'succeeded');
  assert.equal(fixedChild.durableDelivery.status, 'succeeded');
  assert.equal(fixedParent.relations[0].returned.status, 'failed');
  assert.equal(fixedParent.relations[0].returned.failure.receptionAllowed, false);
  assert.throws(() => adapter.models.get(root.context.id).projectFrame());
  assert.equal(adapter.store.read(root.context.id).image.frame.children[0].state.kind, 'waiting');
  assert.equal(adapter.store.read(root.context.id).delivery.status, 'failed');
});

test('a failed Work close prevents successful work and parent delivery despite a successful body candidate', async (t) => {
  const adapter = setup(t);
  const bindings = declarations();
  const failure = new Error('work close failed');
  let child;
  let relation;
  const root = adapter.create({
    binding: bindings.parent,
    async execute(_context, invocation) {
      child = adapter.create({
        parent: invocation,
        binding: bindings.child,
        execute(_context, childInvocation) {
          save(childInvocation, 'prepared');
          return 'candidate';
        },
        close: () => ({ status: 'failed', failure }),
      });
      relation = invocation.children.get(child);
      return child.run();
    },
  });
  await assert.rejects(root.run(), (error) => error === failure);
  assert.equal(child.context.status, 'failed');
  assert.equal(adapter.store.read(child.context.id).delivery.status, 'failed');
  assert.equal(relation.returned.status, 'failed');
  assert.equal(relation.returned.failure.receptionAllowed, false);
});

for (const mode of ['owned-cancellation', 'foreign-cancellation', 'ordinary-error-with-abort', 'cancellation-and-close-error']) {
  test(`cancellation classification remains exact for ${mode}`, async (t) => {
    const adapter = setup(t);
    const controller = new AbortController();
    const ordinary = new Error('ordinary failure');
    const closeError = new Error('additional close failure');
    let cancellation;
    const root = adapter.create({
      signal: controller.signal,
      binding: lifecycleBinding(`study.adapter.${mode}`),
      execute(_context, invocation) {
        save(invocation, 'prepared');
        controller.abort('requested');
        const source = mode === 'foreign-cancellation' ? new AbortController() : controller;
        if (!source.signal.aborted) source.abort('another invocation');
        cancellation = new InvocationCancelled(source.signal);
        throw mode === 'ordinary-error-with-abort' ? ordinary : cancellation;
      },
      ...(mode === 'cancellation-and-close-error' ? { close: () => ({ status: 'failed', failure: closeError }) } : {}),
    });
    await assert.rejects(root.run(), (error) => {
      if (mode === 'owned-cancellation' || mode === 'foreign-cancellation') return error === cancellation;
      if (mode === 'ordinary-error-with-abort') return error === ordinary;
      return error instanceof AggregateError;
    });
    assert.equal(root.context.status, 'failed');
    const expected = mode === 'owned-cancellation' ? 'cancelled' : 'failed';
    assert.equal(adapter.store.read(root.context.id).delivery.status, expected);
    assert.equal(adapter.models.get(root.context.id).readHead().delivery.status, expected);
  });
}

test('pre-aborted child records the real round-zero cancellation without inventing a first child checkpoint', async (t) => {
  const adapter = setup(t);
  const bindings = declarations();
  const controller = new AbortController();
  controller.abort('cancelled before child start');
  let child;
  let relation;
  let bodyCalls = 0;
  let delivered;
  const root = adapter.create({
    binding: bindings.parent,
    async execute(_context, invocation) {
      child = adapter.create({
        parent: invocation,
        signal: controller.signal,
        binding: bindings.child,
        receiveFailure: true,
        execute() {
          bodyCalls++;
          assert.fail('Pre-aborted child body must not start');
        },
      });
      relation = invocation.children.get(child);
      save(invocation, 'waiting');
      return child.run();
    },
  });
  await assert.rejects(root.run(), (error) => {
    delivered = error;
    return error instanceof InvocationCancelled && error.belongsTo(controller.signal);
  });
  assert.equal(bodyCalls, 0);
  assert.equal(child.context.progress.round, 0);
  assert.equal(child.context.status, 'failed');
  assert.equal(relation.returned.error, delivered, 'Instrumentation does not replace cancellation with its own observation error');
  assert.equal(relation.returned.failure.receptionAllowed, false);
  assert.equal(relation.reception.status, 'pending');
  const fixedChild = adapter.models.get(child.context.id).inspect();
  const fixedRelation = adapter.models.get(root.context.id).relation(child.context.id);
  assert.equal(fixedChild.workTerminal.status, 'failed');
  assert.equal(fixedChild.durableDelivery, null);
  assert.equal(fixedRelation.returned.status, 'failed');
  assert.equal(fixedRelation.progress.round, 0);
  assert.equal(fixedRelation.reception.status, 'pending');
  assert.equal(adapter.store.read(child.context.id), undefined);
  assert.throws(() => adapter.models.get(root.context.id).projectFrame(), /Unstarted child progress is not checkpoint recovery evidence/);
  assert.throws(() => adapter.models.get(child.context.id).projectFrame({ round: 0, phase: 'execute' }), /first.round|execute frame/i);
  const retained = adapter.store.read(root.context.id);
  assert.equal(retained.image.state.label, 'waiting');
  assert.equal(retained.image.frame.children[0].state.kind, 'waiting');
  assert.equal(retained.delivery.status, 'failed');
});

test('mutating input before its first production save is a rejected stable-candidate mismatch, not silently recaptured', async (t) => {
  const adapter = setup(t);
  const input = { nested: { text: 'constructed' } };
  const root = adapter.create({
    input,
    binding: lifecycleBinding('study.adapter.input-alias'),
    execute(context, invocation) {
      assert.equal(context.input, input);
      input.nested.text = 'changed before save';
      save(invocation, 'first');
      assert.fail('Live alias divergence must be visible');
    },
  });
  await assert.rejects(root.run(), /equal|match|differ|fixed|input/i);
  assert.equal(input.nested.text, 'changed before save');
  assert.equal(Object.isFrozen(input), false, 'Adapter does not install stable values into production');
  assert.equal(adapter.store.read(root.context.id), undefined);
});

test('mutating a returned alias cannot make a fixed boundary projection follow the live production value', async (t) => {
  const adapter = setup(t);
  const bindings = declarations();
  const output = { nested: { text: 'returned' } };
  let relation;
  const root = adapter.create({
    binding: bindings.parent,
    async execute(_context, invocation) {
      const child = adapter.create({ parent: invocation, binding: bindings.child, execute: () => output });
      relation = invocation.children.get(child);
      await child.run();
      save(invocation, 'before-change');
      output.nested.text = 'mutated alias';
      assert.equal(relation.returned.output, output);
      save(invocation, 'after-change');
      assert.fail('A new stable boundary must not be fabricated to hide mutation');
    },
  });
  await assert.rejects(root.run(), /equal|match|differ|fixed/i);
  assert.equal(output.nested.text, 'mutated alias');
  assert.equal(Object.isFrozen(output), false);
  assert.equal(adapter.store.read(root.context.id).image.state.label, 'before-change');
  assert.equal(adapter.store.read(root.context.id).image.frame.children[0].state.output.nested.text, 'returned');
});
