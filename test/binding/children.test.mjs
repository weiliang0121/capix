import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, InvocationEntry, MemoryCheckpointStore, assembleRuntime } from '@capix/server-runtime';
import { BoundChildren, resolveDeclaration, ChildBindingsBuilder, Invocation, InvocationContext, RuntimeContext } from '@capix/server-runtime/construction';
import { runtimeDefinition } from '../fixtures/declarations.mjs';

function operation(execute = (context) => context.currentInput) {
  return { level: 'operation', name: 'child', label: 'Child', source: 'test', children: [], maxRounds: 1, raises: [], run: { requires: {}, execute } };
}

function assemble(child, run, options = {}) {
  const execution = { level: 'execution', children: [child], maxRounds: 1, raises: [], ...options, run: { requires: {}, ...run } };
  return assembleRuntime(runtimeDefinition(execution), { providers: [], source: { entry: () => null, capture: () => null } });
}

test('run and acceptance bindings share the exact child delivery across their distinct views', async () => {
  const delivered = { value: 7 };
  const child = operation(() => delivered);
  let call;
  let executionBindings;
  let executionView;
  const runtime = assemble(child, {
    async execute(_context, invocation, children) {
      executionBindings = children;
      executionView = invocation;
      call = children.get(child).create(invocation, null);
      return call.run();
    },
    accept(_context, output, invocation, children) {
      assert.equal(output, delivered);
      assert.notEqual(children, executionBindings);
      assert.notEqual(invocation, executionView);
      assert.equal(invocation.children.get(call).reception.status, 'pending');
      return children.accept(call, (value) => {
        assert.equal(value, delivered);
        return value.value * 2;
      });
    },
  });
  assert.equal(await runtime.run(null, {}), 14);
  assert.equal(executionView.children.get(call).reception.status, 'accepted');
});

test('a handler with no child creation grants can accept a child delivered during run', async () => {
  const rejected = new ExceptionContract('test.childBinding.receive');
  const delivered = { answer: 'retained' };
  const child = operation(() => delivered);
  let call;
  const runtime = assemble(
    child,
    {
      uses: [child],
      async execute(_context, invocation, children) {
        call = children.get(child).create(invocation, null);
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
        handle(_context, _exception, _invocation, children) {
          return children.accept(call, (value) => {
            assert.equal(value, delivered);
            return { kind: 'return', output: value.answer };
          });
        },
      },
    },
  );
  assert.equal(await runtime.run(null, {}), 'retained');
});

test('one reusable binding does not share its child call registry between parent invocations', async () => {
  const child = operation();
  let previous;
  let foreignReceipts = 0;
  const runtime = assemble(child, {
    async execute(context, invocation, children) {
      if (previous) {
        return children.accept(previous, () => {
          foreignReceipts++;
          return 'foreign';
        });
      }
      previous = children.get(child).create(invocation, context.currentInput);
      await previous.run();
      return children.accept(previous, (value) => value);
    },
  });
  assert.equal(await runtime.run('first', {}), 'first');
  await assert.rejects(runtime.run('second', {}), /not a child created through this binding/);
  assert.equal(foreignReceipts, 0);
});

for (const boundary of ['phase', 'round']) {
  for (const action of ['create', 'accept']) {
    test(`a retained child binding cannot ${action} across an expired ${boundary}`, async () => {
      const rejected = new ExceptionContract(`test.childBinding.${boundary}.${action}`);
      let calls = 0;
      let receptions = 0;
      let retained;
      const child = operation(() => {
        calls++;
        return 'delivered';
      });
      const useRetained = () => {
        if (action === 'create') return retained.children.get(child).create(retained.invocation, null);
        return retained.children.accept(retained.call, () => {
          receptions++;
          return 'accepted';
        });
      };
      const runtime = assemble(
        child,
        {
          async execute(context, invocation, children) {
            if (context.progress.round === 2) return useRetained();
            const call = children.get(child).create(invocation, null);
            await call.run();
            retained = { children, invocation, call };
            if (boundary === 'phase') throw rejected.create('switch to handler', {});
            return 'next';
          },
          accept(context, output) {
            return context.progress.round === 1 ? context.continueWith('next', 'verify previous access expires') : output;
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
      create(parent, input) {
        return new Invocation({ parent: { invocation: parent }, context: new InvocationContext(input), signal: new AbortController().signal, work: { maxRounds: 1, execute: (context) => context.currentInput } });
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
      context: new InvocationContext(input),
      signal: new AbortController().signal,
      work: {
        maxRounds: 1,
        async execute(context, invocation) {
          const registry = new Map();
          const allowed = [definition];
          const bindings = builder.build(invocation, { view: invocation.view, uses: allowed, calls: registry });
          accessObjects.push(bindings);
          assert.ok(Object.isFrozen(bindings));
          for (const field of ['parent', 'view', 'validate', 'calls', 'allowed', 'bound']) assert.equal(field in bindings, false);
          const endpoint = bindings.get(definition);
          assert.ok(Object.isFrozen(endpoint));
          assert.equal('parent' in endpoint, false);
          assert.equal('calls' in endpoint, false);
          assert.equal(initialized, input === 'first' ? 0 : 1);
          allowed.length = 0;
          // Editing the input array cannot revoke or widen the already-built access object.
          const call = bindings.get(definition).create(invocation.view, context.currentInput);
          assert.equal(initialized, 1);
          assert.equal(await call.run(), input);
          const reception = builder.build(invocation, { view: invocation.view, uses: [], calls: registry });
          return reception.accept(call, (value) => value);
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
  assert.throws(() => builder.build(parent, { view: parent.view, uses: [unknown], calls: new Map() }), /outside|not declared/);
  assert.equal(bound.initialized(declared), false);
});

test('alternative entry acceptance can cancel its parent without creating or starting the child', async () => {
  const controller = new AbortController();
  let accepted = 0;
  const child = operation(() => assert.fail('cancelled input must not start child work'));
  const entry = new InvocationEntry(child, (_invocation, input) => {
    accepted++;
    controller.abort();
    return input;
  });
  const runtime = assemble(child, {
    execute(_context, invocation, children) {
      assert.throws(() => children.entry(entry).create(invocation, 'input'), /取消/);
      assert.equal(invocation.children.values().length, 0);
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
    checkpoint: { key: 'test.lazy.final-child', version: 1, input: codec, output: codec, points: { saved: { state: codec, resume: { requires: {}, execute: () => assert.fail('final child work cannot resume') } } } },
  };
  const bound = new BoundChildren([resolveDeclaration(definition)], () => assert.fail('final delivery must not initialize the child structure'));
  const builder = new ChildBindingsBuilder(bound);
  const store = new MemoryCheckpointStore();
  const childIdentity = { contextId: 'child-context', level: 'execution', parentContextId: 'parent-context' };
  const childContract = { key: definition.checkpoint.key, version: 1 };
  store.save({ id: 'child-cp', formatVersion: 1, contract: childContract, point: 'saved', frame: { owner: childIdentity, round: 1, phase: 'execute', input: 'child', currentInput: 'child', nextChildOrder: 0, children: [] }, state: null }, 0);
  store.finish('child-context', 1, { status: 'succeeded', output: { answer: 'saved' }, progress: { round: 1, phase: 'receive', currentInput: 'child' } });
  const saved = store.save(
    {
      id: 'parent-cp',
      formatVersion: 1,
      contract: { key: 'test.lazy.parent', version: 1 },
      point: 'waiting',
      frame: { owner: { contextId: 'parent-context', level: 'runtime' }, round: 1, phase: 'execute', input: 'parent', currentInput: 'parent', nextChildOrder: 1, children: [{ identity: childIdentity, contract: childContract, round: 1, order: 0, input: 'child', state: { kind: 'waiting' } }] },
      state: null,
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
        points: {
          waiting: {
            state: codec,
            async execute(_context, invocation) {
              const bindings = builder.build(invocation, { view: invocation.view, uses: [definition], calls: new Map() });
              const endpoint = bindings.get(definition);
              const resumed = endpoint.resume(invocation.view, 'child-context');
              assert.equal(bound.initialized(definition), false);
              assert.equal(endpoint.resume(invocation.view, 'child-context'), resumed);
              const delivered = await resumed.run();
              assert.deepEqual(delivered, { answer: 'saved' });
              return bindings.accept(resumed, (value) => {
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
