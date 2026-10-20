import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, InvocationEntry, MemoryCheckpointStore, checkpointPoint, assembleRuntime } from '@capix/server-runtime';
import { BoundChildren, resolveDeclaration, ChildBindingsBuilder, Invocation, InvocationContext, RuntimeContext } from '@capix/server-runtime/construction';
import { runtimeDefinition } from '../fixtures/declarations.mjs';

function operation(execute = (work) => work.input) {
  return { level: 'operation', name: 'child', label: 'Child', source: 'test', children: [], maxRounds: 1, raises: [], run: { requires: {}, execute } };
}

function assemble(child, run, options = {}) {
  const execution = { level: 'execution', children: [child], maxRounds: 1, raises: [], ...options, run: { requires: {}, ...run } };
  return assembleRuntime(runtimeDefinition(execution), { providers: [], source: { capture: () => null } });
}

test('run and acceptance share an exact child reference across distinct Work actions', async () => {
  const delivered = { value: 7 };
  const child = operation(() => delivered);
  let call;
  let executing;
  let facts;
  const runtime = assemble(child, {
    async execute(work) {
      executing = work;
      facts = work.children.facts;
      call = work.children.create(child, null);
      return call.run();
    },
    accept(work) {
      assert.equal(work.delivered, delivered);
      assert.notEqual(work, executing);
      assert.notEqual(work.children, executing.children);
      assert.equal(work.children.facts.get(call.ref).reception.status, 'pending');
      return work.children.open(call.ref).accept((value) => {
        assert.equal(value, delivered);
        return value.value * 2;
      });
    },
  });
  assert.equal(await runtime.run(null, {}), 14);
  assert.equal(facts.get(call.ref).reception.status, 'accepted');
});

test('a handler with no creation grants can accept an earlier delivery through its current handle', async () => {
  const rejected = new ExceptionContract('test.childBinding.receive');
  const delivered = { answer: 'retained' };
  const child = operation(() => delivered);
  let call;
  const runtime = assemble(
    child,
    {
      uses: [child],
      async execute(work) {
        call = work.children.create(child, null);
        await call.run();
        throw rejected.create('continue by accepting the existing delivery', {});
      },
    },
    {
      raises: [rejected],
      exceptions: {
        requires: {},
        uses: [],
        accepts: [rejected],
        async handle(work) {
          const answer = await work.children.open(call.ref).accept((value) => {
            assert.equal(value, delivered);
            return value.answer;
          });
          return work.return(answer);
        },
      },
    },
  );
  assert.equal(await runtime.run(null, {}), 'retained');
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

for (const boundary of ['phase', 'round']) {
  for (const action of ['create', 'accept']) {
    test(`a retained child handle cannot ${action} across an expired ${boundary}`, async () => {
      const rejected = new ExceptionContract(`test.childBinding.${boundary}.${action}`);
      let calls = 0;
      let receptions = 0;
      let retained;
      const child = operation(() => {
        calls++;
        return 'delivered';
      });
      const useRetained = () => {
        if (action === 'create') return retained.children.create(child, null);
        return retained.call.accept(() => {
          receptions++;
          return 'accepted';
        });
      };
      const runtime = assemble(
        child,
        {
          async execute(work) {
            if (work.round === 2) return useRetained();
            const call = work.children.create(child, null);
            await call.run();
            retained = { children: work.children, call };
            if (boundary === 'phase') throw rejected.create('switch to handler', {});
            return 'next';
          },
          accept(work) {
            return work.round === 1 ? work.continue('next', 'verify previous access expires') : work.delivered;
          },
        },
        {
          maxRounds: boundary === 'round' ? 2 : 1,
          raises: [rejected],
          exceptions: { requires: {}, uses: [], accepts: [rejected], handle: useRetained },
        },
      );
      await assert.rejects(runtime.run(null, {}), new RegExp(`inactive declaration ${boundary}`));
      assert.equal(calls, 1);
      assert.equal(receptions, 0);
    });
  }
}

test('building access and obtaining an endpoint stay lazy, and a reused builder keeps invocation state separate', async () => {
  const definition = operation();
  let initialized = 0;
  const bound = new BoundChildren([resolveDeclaration(definition)], (actual) => {
    assert.equal(actual.definition, definition);
    initialized++;
    return {
      create(parent, input, options) {
        return new Invocation({ parent: { invocation: parent, ...options }, context: new InvocationContext(input), signal: new AbortController().signal, work: { maxRounds: 1, execute: (context) => context.currentInput } });
      },
      resume() {
        assert.fail('normal access must not resume a child');
      },
    };
  });
  const builder = new ChildBindingsBuilder(bound);
  const accessObjects = [];
  const parents = [];
  for (const input of ['first', 'second']) {
    const parent = new Invocation({
      context: new RuntimeContext(input),
      signal: new AbortController().signal,
      work: {
        maxRounds: 1,
        async execute(context, invocation) {
          const references = builder.references(invocation);
          const allowed = [definition];
          const bindings = builder.build(invocation, { validate: () => context.requireRunning(), uses: allowed, references });
          accessObjects.push(bindings);
          assert.ok(Object.isFrozen(bindings));
          for (const field of ['parent', 'view', 'validate', 'calls', 'allowed', 'bound']) assert.equal(field in bindings, false);
          assert.equal(initialized, input === 'first' ? 0 : 1);
          allowed.length = 0;
          // Editing the input array cannot revoke or widen the already-built access object.
          const call = bindings.create(definition, context.currentInput);
          assert.equal(initialized, 1);
          assert.equal(await call.run(), input);
          const reception = builder.build(invocation, { validate: () => context.requireRunning(), uses: [], references });
          return reception.open(call.ref).accept();
        },
      },
    });
    parents.push(parent);
    assert.equal(await parent.run(), input);
  }
  assert.equal(initialized, 1);
  assert.notEqual(accessObjects[0], accessObjects[1]);
  assert.notEqual(parents[0].context.id, parents[1].context.id);
});

test('a builder rejects an unknown declaration before any lazy child structure is initialized', () => {
  const declared = operation();
  const unknown = operation();
  const bound = new BoundChildren([resolveDeclaration(declared)], () => assert.fail('invalid grants must not initialize any child'));
  const builder = new ChildBindingsBuilder(bound);
  const parent = new Invocation({ context: new InvocationContext(null), signal: new AbortController().signal, work: { maxRounds: 1, execute: () => null } });
  assert.throws(() => builder.build(parent, { validate: () => {}, uses: [unknown], references: builder.references(parent) }), /outside|not declared/);
  assert.equal(bound.initialized(declared), false);
});

test('alternative entry acceptance can cancel its parent without creating or starting the child', async () => {
  const controller = new AbortController();
  let accepted = 0;
  const child = operation(() => assert.fail('cancelled input must not start child work'));
  const entry = new InvocationEntry(child, ({ input }) => {
    accepted++;
    controller.abort();
    return input;
  });
  const runtime = assemble(child, {
    execute(work) {
      assert.throws(() => work.children.entry(entry, 'input'), /取消/);
      assert.equal(work.children.facts.values().length, 0);
      return 'caught';
    },
  });
  await assert.rejects(runtime.run(null, { signal: controller.signal }), /取消/);
  assert.equal(accepted, 1);
});

test('resuming a saved final child delivery keeps its bound structure uninitialized', async () => {
  const codec = { encode: (value) => value, decode: (value) => value };
  const definition = {
    level: 'execution',
    children: [],
    maxRounds: 1,
    raises: [],
    run: { requires: {}, execute: () => assert.fail('final child work cannot execute again') },
    checkpoint: { key: 'test.lazy.final-child', version: 1, input: codec, output: codec, points: [checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { execute: () => assert.fail('final child work cannot resume') } })] },
  };
  const bound = new BoundChildren([resolveDeclaration(definition)], () => assert.fail('final delivery must not initialize the child structure'));
  const builder = new ChildBindingsBuilder(bound);
  const store = new MemoryCheckpointStore();
  const childIdentity = { contextId: 'child-context', level: 'execution', parentContextId: 'parent-context' };
  const childContract = { key: definition.checkpoint.key, version: 1 };
  store.save({ id: 'child-cp', formatVersion: 3, contract: childContract, point: 'saved', frame: { owner: childIdentity, round: 1, phase: 'execute', input: 'child', currentInput: 'child', nextChildOrder: 0, children: [] }, state: null, references: {} }, 0);
  store.finish('child-context', 1, { status: 'succeeded', output: { answer: 'saved' }, progress: { round: 1, phase: 'receive', currentInput: 'child' } });
  const saved = store.save(
    {
      id: 'parent-cp',
      formatVersion: 3,
      contract: { key: 'test.lazy.parent', version: 1 },
      point: 'waiting',
      frame: { owner: { contextId: 'parent-context', level: 'runtime' }, round: 1, phase: 'execute', input: 'parent', currentInput: 'parent', nextChildOrder: 1, children: [{ identity: childIdentity, target: { position: 0 }, contract: childContract, round: 1, order: 0, input: 'child', state: { kind: 'waiting' } }] },
      state: null,
      references: {},
    },
    0,
  );
  const context = new RuntimeContext('parent');
  context.installCheckpoint({ id: 'parent-context', round: 1, currentInput: 'parent' });
  const parent = new Invocation({
    context,
    signal: context.signal,
    checkpoints: { store },
    restore: { head: saved },
    work: {
      maxRounds: 1,
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
              assert.equal(bound.initialized(definition), false);
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
  assert.equal(bound.initialized(definition), false);
});
