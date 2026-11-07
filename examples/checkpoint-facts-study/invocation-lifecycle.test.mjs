import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resources, Runner, Scene } from '@capix/server-runtime';
import { InvocationLifecycleProbe, lifecycleBinding, lifecycleCodec, lifecycleReception } from './invocation-lifecycle.mjs';

function declarations() {
  const child = lifecycleBinding('study.lifecycle.child');
  const reception = lifecycleReception();
  const parent = lifecycleBinding('study.lifecycle.parent', { children: [{ kind: 'node', binding: child }], receptions: [reception] });
  return { parent, child, reception };
}

test('real lifecycle: waiting, returned, receiving and accepted snapshots match actual Frame v5', async () => {
  const probe = new InvocationLifecycleProbe();
  const bindings = declarations();
  let child;
  let relation;
  const root = probe.create({
    input: { task: 'read' },
    binding: bindings.parent,
    async execute(_context, invocation) {
      child = probe.create({
        parent: invocation,
        input: { path: 'notes' },
        key: 'reader',
        binding: bindings.child,
        execute(_childContext, childInvocation) {
          probe.save(childInvocation, 'child-prepared');
          return { text: 'body' };
        },
      });
      relation = invocation.children.get(child);
      probe.save(invocation, 'waiting', child);
      assert.equal(child.context.progress.round, 0);
      await child.run();
      probe.save(invocation, 'returned', child);
      const result = await relation.accept((value) => {
        probe.save(invocation, 'receiving', child);
        assert.deepEqual(invocation.children.reception, { parentContextId: invocation.context.id, childContextId: child.context.id });
        return { text: value.text.toUpperCase() };
      }, bindings.reception);
      assert.throws(() => invocation.children.reception, /active direct-child reception/);
      probe.save(invocation, 'accepted', child);
      return result;
    },
  });
  assert.deepEqual(await probe.run(root), { text: 'BODY' });
  const images = probe.images(root.context.id);
  assert.deepEqual(
    images.map((image) => image.state.label),
    ['waiting', 'returned', 'receiving', 'accepted'],
  );
  assert.deepEqual(
    images.map((image) => image.frame.children[0].state.kind),
    ['waiting', 'returned', 'returned', 'returned'],
  );
  assert.deepEqual(
    images.slice(1).map((image) => image.frame.children[0].state.reception.kind),
    ['pending', 'receiving', 'accepted'],
  );
  for (const image of images) {
    assert.equal(image.formatVersion, 5);
    assert.deepEqual(image.frame.input, { task: 'read' });
    assert.equal(image.frame.nextChildOrder, 1);
    const saved = image.frame.children[0];
    assert.deepEqual(saved.identity, child.identity);
    assert.equal(saved.order, relation.order);
    assert.equal(saved.target.position, relation.declarationPosition);
    assert.deepEqual(saved.input, { path: 'notes' });
  }
  assert.deepEqual(images[2].frame.children[0].state.reception.contract, { position: 0 });
  assert.deepEqual(images[3].frame.children[0].state.reception.output, { text: 'BODY' });
  assert.deepEqual(
    probe
      .events(root.context.id)
      .filter((fact) => fact.kind === 'relation')
      .map((fact) => fact.change.kind),
    ['attached', 'returned', 'receiving', 'accepted'],
  );
  const finished = probe.timeline.findIndex((event) => event.kind === 'observation' && event.fact.identity.contextId === child.context.id && event.fact.kind === 'finished');
  const committed = probe.timeline.findIndex((event) => event.kind === 'store.finish.committed' && event.contextId === child.context.id);
  const returned = probe.timeline.findIndex((event) => event.kind === 'observation' && event.fact.kind === 'relation' && event.fact.change.kind === 'returned');
  assert.ok(finished < committed && committed < returned, 'Work completion precedes durable delivery and parent return');
  assert.equal(probe.memory.read(root.context.id).delivery.status, 'succeeded');
});

test('real handled failure: successful parent reception does not rewrite the failed child delivery', async () => {
  const probe = new InvocationLifecycleProbe();
  const bindings = declarations();
  const failure = new Error('reader unavailable');
  let child;
  let relation;
  const root = probe.create({
    binding: bindings.parent,
    async execute(_context, invocation) {
      child = probe.create({
        parent: invocation,
        receiveFailure: true,
        binding: bindings.child,
        execute(_childContext, childInvocation) {
          probe.save(childInvocation, 'prepared');
          throw failure;
        },
      });
      relation = invocation.children.get(child);
      probe.save(invocation, 'waiting', child);
      await assert.rejects(child.run(), (error) => error === failure);
      probe.sample('failed-before-handling', invocation, child);
      const output = await relation.handle((error) => {
        assert.equal(error, failure);
        return { fallback: true };
      }, bindings.reception);
      probe.save(invocation, 'handled', child);
      return output;
    },
  });
  assert.deepEqual(await probe.run(root), { fallback: true });
  assert.equal(child.context.status, 'failed');
  assert.equal(probe.memory.read(child.context.id).delivery.status, 'failed');
  assert.equal(relation.returned.status, 'failed');
  assert.equal(relation.returned.error, failure);
  assert.equal(relation.reception.status, 'handled');
  const saved = probe.images(root.context.id).at(-1).frame.children[0];
  assert.equal(saved.state.kind, 'failed');
  assert.equal(saved.state.reception.kind, 'handled');
  assert.deepEqual(saved.state.reception.output, { fallback: true });
  assert.equal(probe.memory.read(root.context.id).delivery.status, 'succeeded');
});

test('real reception callback failure retains successful child return and accurate failed reception', async () => {
  const probe = new InvocationLifecycleProbe();
  const bindings = declarations();
  const failure = new Error('acceptance failed');
  let child;
  let relation;
  const root = probe.create({
    binding: bindings.parent,
    async execute(_context, invocation) {
      child = probe.create({ parent: invocation, binding: bindings.child, execute: () => ({ text: 'result' }) });
      relation = invocation.children.get(child);
      await child.run();
      probe.save(invocation, 'returned', child);
      return relation.accept(() => {
        throw failure;
      }, bindings.reception);
    },
  });
  await assert.rejects(probe.run(root), (error) => error === failure);
  assert.equal(child.context.status, 'succeeded');
  assert.equal(relation.returned.status, 'succeeded');
  assert.equal(relation.reception.status, 'failed');
  assert.equal(relation.reception.error, failure);
  assert.equal(relation.reception.failure.contextId, root.context.id);
  assert.equal(relation.reception.contract, bindings.reception);
  const event = probe.events(root.context.id).find((fact) => fact.kind === 'relation' && fact.change.kind === 'failed');
  assert.equal(event.change.source, 'work');
  assert.equal(Object.hasOwn(event.change, 'failure'), false, 'Observation does not carry the complete classified reception failure');
  assert.equal(probe.memory.read(root.context.id).delivery.status, 'failed');
});

test('real strict accepted observation failure cannot roll back an established acceptance', async () => {
  const probe = new InvocationLifecycleProbe();
  const bindings = declarations();
  const failure = new Error('acceptance observer failed');
  let relation;
  const root = probe.create({
    binding: bindings.parent,
    observe(fact) {
      if (fact.kind === 'relation' && fact.change.kind === 'accepted') throw failure;
    },
    async execute(_context, invocation) {
      const child = probe.create({ parent: invocation, binding: bindings.child, execute: () => ({ child: true }) });
      relation = invocation.children.get(child);
      await child.run();
      probe.save(invocation, 'returned', child);
      return relation.accept(() => ({ accepted: true }), bindings.reception);
    },
  });
  await assert.rejects(probe.run(root), (error) => error.cause === failure);
  assert.equal(root.context.status, 'failed');
  assert.equal(relation.returned.status, 'succeeded');
  assert.equal(relation.reception.status, 'accepted');
  assert.deepEqual(relation.reception.output, { accepted: true });
  assert.equal(probe.events(root.context.id).filter((fact) => fact.kind === 'relation' && fact.change.kind === 'accepted').length, 1);
  assert.equal(probe.memory.read(root.context.id).image.frame.children[0].state.reception.kind, 'pending', 'Last saved image is not retroactively updated');
  assert.equal(probe.memory.read(root.context.id).delivery.status, 'failed');
});

test('real strict receiving observation failure prevents the callback and records an observation-origin failure', async () => {
  const probe = new InvocationLifecycleProbe();
  const bindings = declarations();
  const failure = new Error('receiving observer failed');
  let callbackCalls = 0;
  let relation;
  const root = probe.create({
    observe(fact) {
      if (fact.kind === 'relation' && fact.change.kind === 'receiving') throw failure;
    },
    async execute(_context, invocation) {
      const child = probe.create({ parent: invocation, execute: () => 'delivered' });
      relation = invocation.children.get(child);
      await child.run();
      return relation.accept(() => {
        callbackCalls++;
        return 'accepted';
      }, bindings.reception);
    },
  });
  await assert.rejects(probe.run(root), (error) => error.cause === failure);
  assert.equal(callbackCalls, 0);
  assert.equal(relation.returned.status, 'succeeded');
  assert.equal(relation.reception.status, 'failed');
  assert.equal(relation.reception.contract, bindings.reception);
  assert.equal(relation.reception.error.cause, failure);
  const failed = probe.events(root.context.id).find((fact) => fact.kind === 'relation' && fact.change.kind === 'failed');
  assert.equal(failed.change.source, 'observation');
});

test('real Work close failure prevents successful return even though the body produced a value', async () => {
  const probe = new InvocationLifecycleProbe();
  const failure = new Error('required Work close failed');
  let child;
  let relation;
  let bodyCalls = 0;
  let closeCalls = 0;
  const root = probe.create({
    async execute(_context, invocation) {
      child = probe.create({
        parent: invocation,
        receiveFailure: true,
        execute() {
          bodyCalls++;
          return { candidate: true };
        },
        close() {
          closeCalls++;
          return { status: 'failed', failure };
        },
      });
      relation = invocation.children.get(child);
      await child.run();
      assert.fail('Cannot consume a successful delivery after close failed');
    },
  });
  await assert.rejects(probe.run(root), (error) => error === failure);
  assert.equal(bodyCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(child.context.status, 'failed');
  assert.equal(relation.returned.status, 'failed');
  assert.equal(relation.returned.failure.receptionAllowed, false);
  assert.equal(relation.reception.status, 'pending');
  assert.equal(
    probe.events(child.context.id).some((fact) => fact.kind === 'process' && fact.process.type === 'return'),
    false,
  );
});

test('real finish commit then lost acknowledgement separates work, durable delivery and parent return', async () => {
  const probe = new InvocationLifecycleProbe();
  const bindings = declarations();
  const failure = new Error('finish acknowledgement lost');
  let child;
  let relation;
  let executions = 0;
  probe.afterFinish = () => {
    throw failure;
  };
  const root = probe.create({
    async execute(_context, invocation) {
      child = probe.create({
        parent: invocation,
        receiveFailure: true,
        binding: bindings.child,
        execute(_childContext, childInvocation) {
          executions++;
          probe.save(childInvocation, 'prepared');
          return { result: 'finished' };
        },
      });
      relation = invocation.children.get(child);
      return child.run();
    },
  });
  await assert.rejects(probe.run(root), (error) => error === failure);
  assert.equal(executions, 1);
  assert.equal(child.context.status, 'succeeded');
  assert.deepEqual(child.context.state.output, { result: 'finished' });
  const head = probe.memory.read(child.context.id);
  assert.equal(head.revision, 2);
  assert.equal(head.delivery.status, 'succeeded');
  assert.equal(relation.returned.status, 'failed');
  assert.equal(relation.returned.failure.receptionAllowed, false);
  assert.equal(relation.reception.status, 'pending');
  assert.equal(probe.timeline.filter((event) => event.kind === 'store.finish.enter').length, 1, 'No fabricated failed finish or retry after uncertainty');
  assert.equal(probe.events(child.context.id).find((fact) => fact.kind === 'finished').state.status, 'succeeded');
  assert.equal(
    probe.timeline.some((event) => event.kind === 'checkpoint' && event.fact.contextId === child.context.id && event.fact.kind === 'finished'),
    false,
    'Lost acknowledgement is not announced as confirmed',
  );
});

test('real unstarted child: attached observation omits authority present in the parent Frame', async () => {
  const probe = new InvocationLifecycleProbe();
  const bindings = declarations();
  let child;
  const root = probe.create({
    binding: bindings.parent,
    execute(_context, invocation) {
      child = probe.create({ parent: invocation, key: 'unused', input: { query: 'unstarted' }, binding: bindings.child, execute: () => assert.fail('Child must stay unstarted') });
      probe.save(invocation, 'waiting', child);
      return 'parent completes';
    },
  });
  assert.equal(await probe.run(root), 'parent completes');
  assert.equal(child.context.status, 'running');
  assert.equal(child.context.progress.round, 0);
  assert.deepEqual(probe.events(child.context.id), []);
  const attached = probe.events(root.context.id).find((fact) => fact.kind === 'relation');
  assert.deepEqual(attached.change, { kind: 'attached' });
  for (const field of ['order', 'position', 'input', 'contract']) assert.equal(Object.hasOwn(attached.relation, field), false);
  const saved = probe.memory.read(root.context.id).image.frame.children[0];
  assert.equal(saved.state.kind, 'waiting');
  assert.equal(saved.order, 0);
  assert.deepEqual(saved.target, { position: 0 });
  assert.deepEqual(saved.input, { query: 'unstarted' });
  assert.deepEqual(saved.contract, { key: bindings.child.key, version: 1 });
  assert.equal(probe.memory.read(child.context.id), undefined, 'An attached relationship is not a durable child continuation');
});

test('real production values remain live references: observation-time copies and later CP can disagree', async () => {
  const probe = new InvocationLifecycleProbe();
  const bindings = declarations();
  const output = { nested: { value: 'returned' } };
  const accepted = { nested: { value: 'accepted' } };
  let relation;
  const root = probe.create({
    binding: bindings.parent,
    async execute(_context, invocation) {
      const child = probe.create({ parent: invocation, binding: bindings.child, execute: () => output });
      relation = invocation.children.get(child);
      await child.run();
      await relation.accept(() => accepted, bindings.reception);
      probe.save(invocation, 'before-mutation', child);
      output.nested.value = 'changed returned alias';
      accepted.nested.value = 'changed accepted alias';
      assert.equal(relation.returned.output, output);
      assert.equal(relation.reception.output, accepted);
      probe.save(invocation, 'after-mutation', child);
      return accepted;
    },
  });
  assert.equal(await probe.run(root), accepted);
  const images = probe.images(root.context.id);
  assert.equal(images[0].frame.children[0].state.output.nested.value, 'returned');
  assert.equal(images[1].frame.children[0].state.output.nested.value, 'changed returned alias');
  assert.equal(images[0].frame.children[0].state.reception.output.nested.value, 'accepted');
  assert.equal(images[1].frame.children[0].state.reception.output.nested.value, 'changed accepted alias');
  const events = probe.events(root.context.id).filter((fact) => fact.kind === 'relation');
  assert.equal(events.find((fact) => fact.change.kind === 'returned').change.result.output.nested.value, 'returned');
  assert.equal(events.find((fact) => fact.change.kind === 'accepted').change.output.nested.value, 'accepted');
  assert.equal(Object.isFrozen(output), false, 'This probe does not install experimental stable delivery');
});

test('real input reference can mutate before its first save; subsequent Store invariants reject a changed original input', async () => {
  const probe = new InvocationLifecycleProbe();
  const input = { nested: { value: 'constructed' } };
  const root = probe.create({
    input,
    binding: lifecycleBinding('study.lifecycle.input'),
    execute(context, invocation) {
      assert.equal(context.input, input);
      input.nested.value = 'before first save';
      probe.save(invocation, 'first');
      input.nested.value = 'after first save';
      assert.equal(context.input.nested.value, 'after first save');
      probe.save(invocation, 'second');
      assert.fail('Changed input cannot replace an established CP original input');
    },
  });
  await assert.rejects(probe.run(root), /original input cannot change/);
  const head = probe.memory.read(root.context.id);
  assert.equal(head.image.frame.input.nested.value, 'before first save');
  assert.equal(root.context.input.nested.value, 'after first save');
  assert.equal(probe.timeline.filter((event) => event.kind === 'store.save.committed').length, 1);
});

test('real Runner release failure is an entry failure after successful root work and durable delivery', async () => {
  const probe = new InvocationLifecycleProbe();
  const failure = new Error('root release failed');
  const observations = [];
  const outputs = [];
  const point = { name: 'prepared', state: lifecycleCodec, references: {}, resume: { deps: {}, run: () => assert.fail('No recovery is requested') } };
  const scene = new Scene({
    output: { result: (value) => value, delta: (value) => value },
    checkpoint: { key: 'study.lifecycle.root-release', version: 1, input: lifecycleCodec, output: lifecycleCodec, points: [point] },
    run(work) {
      work.checkpoint({ point, state: null, refs: {} });
      return 'root output';
    },
  });
  const runner = new Runner(scene, new Resources(), undefined, {
    checkpoints: { store: probe.store },
    observations: [
      {
        failure: 'propagate',
        bindInvocation: () => ({ observe: (fact) => probe.record({ kind: 'observation', fact }) }),
        bindDriver: () => ({
          observe(fact) {
            if (fact.kind === 'released') throw failure;
          },
        }),
      },
    ],
  }).build();
  runner.observation.subscribe({ receive: (event) => void observations.push(event) });
  runner.output.subscribe({ receive: (event) => void outputs.push(event) });
  await assert.rejects(runner.run(null), (error) => error.cause === failure);
  const saved = probe.timeline.find((event) => event.kind === 'store.save.enter');
  assert.equal(probe.events(saved.contextId).find((fact) => fact.kind === 'finished').state.status, 'succeeded');
  assert.equal(probe.memory.read(saved.contextId).delivery.status, 'succeeded');
  assert.equal(outputs.at(-1).kind, 'completed');
  assert.equal(outputs.at(-1).result, 'root output');
  const settled = observations.findLast((event) => event.source === 'entry' && event.fact.kind === 'settled');
  assert.equal(settled.fact.status, 'failed');
  assert.equal(settled.entryId, outputs.at(-1).entryId);
  assert.equal(runner.isRunning, false);
});
