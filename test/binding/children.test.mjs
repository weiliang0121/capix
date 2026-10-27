import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Group, checkpointPoint } from '@capix/server-runtime';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { BoundChildren, resolveDeclaration, ChildBindingsBuilder, Invocation, InvocationContext, CallableContext, buildCallableFromSource, callableConstruction, createRootInvocation } from '@capix/server-runtime/construction';
import { runtimeDefinition } from '../fixtures/declarations.mjs';

function operation(execute = (work) => work.input) {
  return new Group({ name: 'child', label: 'Child', source: 'test', deps: {}, run: execute });
}

function assemble(child, run, options = {}) {
  const execution = new Group({ ...options, deps: run.deps ?? {}, run: run.execute.bind(run) }).add(child);
  return installCallable(runtimeDefinition(execution), { providers: [], source: { capture: () => null } });
}

test('an exact child reference separates returned output from parent reception', async () => {
  const delivered = { value: 7 };
  const child = operation(() => delivered);
  let call;
  let facts;
  const runtime = assemble(child, {
    async execute(work) {
      facts = work.children.facts;
      call = work.children.create(child, null);
      assert.equal(await call.run(), delivered);
      assert.equal(facts.get(call.ref).reception.status, 'pending');
      return work.children.open(call.ref).accept((value) => {
        assert.equal(value, delivered);
        return value.value * 2;
      });
    },
  });
  assert.equal(await runtime.run(null, {}), 14);
  assert.equal(facts.get(call.ref).reception.status, 'accepted');
});

test('one reusable binding rejects a reference from a previous parent activity', async () => {
  const child = operation();
  let previous;
  let foreignReceipts = 0;
  const runtime = assemble(child, {
    async execute(work) {
      if (previous)
        return work.children.open(previous).accept(() => {
          foreignReceipts++;
          return 'foreign';
        });
      const call = work.children.create(child, work.input);
      previous = call.ref;
      await call.run();
      return call.accept();
    },
  });
  assert.equal(await runtime.run('first', {}), 'first');
  await assert.rejects(runtime.run('second', {}), /foreign child reference/);
  assert.equal(foreignReceipts, 0);
});

for (const action of ['create', 'accept']) {
  test(`a retained child handle cannot ${action} after its invocation exits`, async () => {
    let calls = 0;
    let receptions = 0;
    let retained;
    const child = operation(() => {
      calls++;
      return 'delivered';
    });
    const runtime = assemble(child, {
      async execute(work) {
        const call = work.children.create(child, null);
        await call.run();
        retained = { children: work.children, call };
        return 'finished';
      },
    });
    assert.equal(await runtime.run(null, {}), 'finished');
    if (action === 'create') assert.throws(() => retained.children.create(child, null), /inactive|closed|ended|finished/);
    else
      await assert.rejects(
        retained.call.accept(() => {
          receptions++;
          return 'accepted';
        }),
        /inactive|closed|ended|finished/,
      );
    assert.equal(calls, 1);
    assert.equal(receptions, 0);
  });
}

test('building child access does not execute members and a reused builder keeps invocation state separate', async () => {
  let calls = 0;
  const definition = operation((work) => {
    calls++;
    return work.input;
  });
  const accessObjects = [];
  const parents = [];
  let builder;
  const structure = new Group({
    async run(work) {
      const invocation = parents.at(-1);
      const context = invocation.context;
      const references = builder.references(invocation);
      const allowed = [definition];
      const bindings = builder.build(invocation, { validate: () => context.requireRunning(), uses: allowed, references });
      accessObjects.push(bindings);
      assert.ok(Object.isFrozen(bindings));
      for (const field of ['parent', 'view', 'validate', 'calls', 'allowed', 'bound']) assert.equal(field in bindings, false);
      assert.equal(calls, work.input === 'first' ? 0 : 1);
      allowed.length = 0;
      // Editing the input array cannot revoke or widen the already-built access object.
      const call = bindings.create(definition, work.input);
      assert.equal(calls, work.input === 'first' ? 0 : 1);
      assert.equal(await call.run(), work.input);
      const reception = builder.build(invocation, { validate: () => context.requireRunning(), uses: [], references });
      return reception.open(call.ref).accept();
    },
  }).add(definition);
  buildCallableFromSource(structure, {
    providers: [],
    source: {
      capture: () => null,
      started: () => (_context, invocation) => {
        parents.push(invocation);
      },
    },
  });
  const bound = callableConstruction(structure).binding.children;
  builder = new ChildBindingsBuilder(bound);
  assert.equal(bound.get(definition), definition);
  assert.equal(calls, 0);
  for (const input of ['first', 'second']) {
    const parent = createRootInvocation(structure, input, {});
    assert.equal(await parent.run(), input);
  }
  assert.equal(calls, 2);
  assert.notEqual(accessObjects[0], accessObjects[1]);
  assert.notEqual(parents[0].context.id, parents[1].context.id);
});

test('a builder rejects an unknown declaration before creating any child invocation', () => {
  const declared = operation();
  const unknown = operation();
  const bound = new BoundChildren([resolveDeclaration(declared)]);
  const builder = new ChildBindingsBuilder(bound);
  const parent = new Invocation({ context: new InvocationContext(null), signal: new AbortController().signal, work: { execute: () => null } });
  assert.throws(() => builder.build(parent, { validate: () => {}, uses: [unknown], references: builder.references(parent) }), /outside|not declared/);
  assert.equal(bound.get(declared), declared);
  assert.equal(parent.children.values().length, 0);
  assert.throws(() => callableConstruction(declared), /not been built/);
});

test('cancellation during ordinary input preparation prevents subsequent child creation and invocation', async () => {
  const controller = new AbortController();
  let prepared = 0;
  const child = operation(() => assert.fail('cancelled input must not start child work'));
  const prepare = (input) => {
    prepared++;
    controller.abort();
    return input;
  };
  const runtime = assemble(child, {
    async execute(work) {
      const input = prepare('input');
      assert.throws(() => work.children.create(child, input), /取消/);
      await assert.rejects(work.children.invoke(child, input), /取消/);
      assert.equal(work.children.facts.values().length, 0);
      return 'caught';
    },
  });
  await assert.rejects(runtime.run(null, { signal: controller.signal }), /取消/);
  assert.equal(prepared, 1);
});

test('resuming a saved final child delivery needs no child invocation construction', async () => {
  const codec = { encode: (value) => value, decode: (value) => value };
  const definition = new Group({
    deps: {},
    run: () => assert.fail('final child work cannot execute again'),
    checkpoint: { key: 'test.lazy.final-child', version: 1, input: codec, output: codec, points: [checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { run: () => assert.fail('final child work cannot resume') } })] },
  });
  const bound = new BoundChildren([resolveDeclaration(definition)]);
  const builder = new ChildBindingsBuilder(bound);
  const store = new MemoryCheckpointStore();
  const childIdentity = { contextId: 'child-context', kind: 'group', parentContextId: 'parent-context' };
  const childContract = { key: definition.checkpoint.key, version: 1 };
  store.save({ id: 'child-cp', formatVersion: 5, contract: childContract, point: 'saved', frame: { owner: childIdentity, round: 1, phase: 'execute', input: 'child', currentInput: 'child', nextChildOrder: 0, children: [] }, state: null, references: {} }, 0);
  store.finish('child-context', 1, { status: 'succeeded', output: { answer: 'saved' }, progress: { round: 1, phase: 'receive', currentInput: 'child' } });
  const saved = store.save(
    {
      id: 'parent-cp',
      formatVersion: 5,
      contract: { key: 'test.lazy.parent', version: 1 },
      point: 'waiting',
      frame: { owner: { contextId: 'parent-context', kind: 'scene' }, round: 1, phase: 'execute', input: 'parent', currentInput: 'parent', nextChildOrder: 1, children: [{ identity: childIdentity, target: { position: 0 }, contract: childContract, round: 1, order: 0, input: 'child', state: { kind: 'waiting' } }] },
      state: null,
      references: {},
    },
    0,
  );
  const context = new CallableContext('parent', 'scene');
  context.installCheckpoint({ id: 'parent-context', round: 1, currentInput: 'parent' });
  const parent = new Invocation({
    context,
    signal: context.signal,
    checkpoints: { store },
    restore: { head: saved },
    work: {
      execute: () => assert.fail('normal parent work must not replay'),
      checkpoint: {
        key: 'test.lazy.parent',
        version: 1,
        input: codec,
        output: codec,
        children: bound.checkpointLayout(),
        points: {
          waiting: {
            state: codec,
            async execute(_context, invocation) {
              const references = builder.references(invocation);
              const bindings = builder.build(invocation, { validate: () => invocation.context.requireRunning(), uses: [definition], references, restoring: true });
              const ref = references.facts.requireUnique(definition, { parentRound: 1 }).ref;
              const resumed = bindings.resume(ref);
              assert.throws(() => callableConstruction(definition), /not been built/);
              assert.equal(bindings.resume(ref).ref, resumed.ref);
              const delivered = await resumed.run();
              assert.deepEqual(delivered, { answer: 'saved' });
              return resumed.accept((value) => {
                assert.equal(value, delivered);
                return value.answer;
              });
            },
          },
        },
      },
    },
  });
  assert.equal(await parent.run(), 'saved');
  assert.throws(() => callableConstruction(definition), /not been built/);
});
