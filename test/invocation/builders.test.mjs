import { captureSource } from '../fixtures/observer.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Recorder, RecordBook, ChangeBuffer, bindResources, ResourceOffer, ResourceBindings, CallableInvocationBuilder } from '@capix/server-runtime';
import { createBoundRuntime } from '../fixtures/runtime.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const operation = { id: 'operation', name: 'work', label: 'Work', source: 'test' };
const attempt = { name: 'action', label: 'Action', source: 'test', callee: 'processing' };
const identity = { maxRounds: 1, execute: (context) => context.currentInput };

test('independent construction chains reject foreign parents and share one path across callable kinds', async () => {
  const facts = [];
  const observations = [{ bindInvocation: () => ({ observe: (fact) => facts.push(fact) }) }];
  const first = new CallableInvocationBuilder({ observations });
  const foreign = new CallableInvocationBuilder();
  const description = { id: 'first-scene' };
  const parent = first.create('parent', {
    kind: 'scene',
    description,
    controls: {},
    work: {
      maxRounds: 1,
      async execute(_context, invocation) {
        assert.throws(() => foreign.create('wrong owner', { kind: 'group', parent: invocation, work: identity }), /another binding installation/);
        assert.equal(invocation.children.values().length, 0);
        const child = first.create('child output', { kind: 'group', parent: invocation, work: identity });
        await child.run();
        return invocation.children.get(child).accept((output) => output);
      },
    },
  });
  assert.equal(await parent.run(), 'child output');
  const sceneFacts = facts.filter((fact) => fact.identity.kind === 'scene');
  assert.ok(sceneFacts.length > 0);
  assert.ok(sceneFacts.every((fact) => fact.description === description));
  assert.ok(facts.some((fact) => fact.identity.kind === 'group' && fact.identity.parentContextId === parent.context.id));
});

test('resource refinement cancellation prevents child registration and observation construction', async () => {
  const controller = new AbortController();
  const cause = new Error('cancelled during resource refinement');
  const boundKinds = [];
  const builder = new CallableInvocationBuilder({
    observations: [
      {
        bindInvocation({ identity }) {
          boundKinds.push(identity.kind);
          return { observe() {} };
        },
      },
    ],
  });
  const resource = new ResourceOffer('test.refined', (value) => value, 'access', {
    refine(value) {
      controller.abort(cause);
      return value;
    },
  });
  const requires = { value: resource.request() };
  const resources = bindResources(requires, [resource.provide((source) => source)])('value');
  let child;
  const parent = builder.create(null, {
    kind: 'scene',
    controls: { signal: controller.signal },
    resources,
    supply: requires,
    work: {
      maxRounds: 1,
      execute(_context, invocation) {
        assert.throws(
          () => {
            child = builder.create('child', { kind: 'node', parent: invocation, requires, refinements: [resource.refine(() => null)], work: identity });
          },
          (error) => error.code === 'INVOCATION_CANCELLED' && error.cause === cause,
        );
        assert.equal(invocation.children.values().length, 0);
        return null;
      },
    },
  });
  await assert.rejects(parent.run(), (error) => error.code === 'INVOCATION_CANCELLED' && error.cause === cause);
  assert.equal(child, undefined);
  assert.deepEqual(boundKinds, ['scene']);
});

test('reused builders bind each invocation to its own signal, settings and input', async () => {
  const runtime = createBoundRuntime();
  const builders = [runtime.executionInvocationBuilder, runtime.operationInvocationBuilder, runtime.attemptInvocationBuilder];
  const firstController = new AbortController();
  const secondController = new AbortController();
  const mutableSettings = { ...settings };
  const configuration = new ResourceOffer('test.settings', (source) => source);
  const requires = { settings: configuration.request() };
  const resourceBinding = bindResources(requires, [configuration.provide((source) => source.settings)]);
  const observed = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const inspect = {
    maxRounds: 1,
    execute: async (context) => {
      observed.push(context.resources.values.settings.model);
      await pending;
      return context.currentInput;
    },
  };
  const first = runtime.executionInvocationBuilder.create('first', { requires, establish: () => ({ resources: resourceBinding(captureSource({ settings: mutableSettings })) }), context: { signal: firstController.signal }, work: inspect });
  mutableSettings.model = 'next';
  const second = runtime.executionInvocationBuilder.create('second', { requires, establish: () => ({ resources: resourceBinding(captureSource({ settings: mutableSettings })) }), context: { signal: secondController.signal }, work: inspect });
  const firstOperation = runtime.operationInvocationBuilder.create(first, { input: 'first operation', description: operation, work: identity });
  const secondOperation = runtime.operationInvocationBuilder.create(second, { input: 'second operation', description: operation, work: identity });
  const firstAttempt = runtime.attemptInvocationBuilder.create(firstOperation, { input: 'first action', description: attempt, work: identity });
  const secondAttempt = runtime.attemptInvocationBuilder.create(secondOperation, { input: 'second action', description: attempt, work: identity });
  const unstarted = runtime.executionInvocationBuilder.create('unstarted', { requires, establish: () => ({ resources: resourceBinding(captureSource({ settings })) }), context: {}, work: identity });
  assert.throws(() => unstarted.context.resources.values.settings, /started invocation/);
  await assert.rejects(unstarted.run(), /started invocation/);
  const firstRun = first.run();
  const secondRun = second.run();
  assert.deepEqual(observed, ['fixture', 'next']);
  assert.equal(firstAttempt.context.signal, firstController.signal);
  assert.equal(secondAttempt.context.signal, secondController.signal);
  assert.equal(first.context.runtime, undefined);
  assert.equal(first.context.progress.round, 1);
  const cause = new Error('first only');
  firstController.abort(cause);
  await assert.rejects(firstAttempt.run(), (error) => error.code === 'INVOCATION_CANCELLED' && error.cause === cause);
  assert.equal(await secondAttempt.run(), 'second action');
  assert.equal(secondController.signal.aborted, false);
  release();
  await assert.rejects(firstRun, (error) => error.code === 'INVOCATION_CANCELLED' && error.cause === cause);
  assert.equal(await secondRun, 'second');
  assert.deepEqual([runtime.executionInvocationBuilder, runtime.operationInvocationBuilder, runtime.attemptInvocationBuilder], builders);
});

test('construction writes no call records and rejects foreign contexts before starting work', () => {
  const recorder = new Recorder(new RecordBook());
  const first = createBoundRuntime({ recorder });
  const second = createBoundRuntime({ recorder });
  const root = first.executionInvocationBuilder.create('input', { context: { settings }, work: identity });
  const child = first.operationInvocationBuilder.create(root, { input: 'input', description: operation, work: identity });
  assert.equal([...recorder.book.values()].filter((record) => record instanceof Object && ['group', 'node'].includes(record.structureKind)).length, 0);
  assert.throws(() => second.operationInvocationBuilder.create(root, { input: 'foreign', description: operation, work: identity }), /another binding installation/);
  assert.throws(() => second.attemptInvocationBuilder.create(child, { input: 'foreign', description: attempt, work: identity }), /another binding installation/);
  assert.equal([...recorder.book.values()].filter((record) => record instanceof Object && ['group', 'node'].includes(record.structureKind)).length, 0);
});

test('a constructed call rechecks its parent before entering work, including nested operations', async () => {
  const runtime = createBoundRuntime();
  const root = runtime.executionInvocationBuilder.create('root', { context: { settings }, work: identity });
  const parent = runtime.operationInvocationBuilder.create(root, { input: 'parent', description: operation, work: identity });
  const forbidden = { maxRounds: 1, execute: () => assert.fail('ended parent must prevent work') };
  const leaf = runtime.attemptInvocationBuilder.create(parent, { input: 'leaf', description: attempt, work: forbidden });
  const nested = runtime.operationInvocationBuilder.create(parent, { input: 'nested', description: operation, work: forbidden });
  parent.context.complete('done');
  await assert.rejects(leaf.run(), /ended/);
  await assert.rejects(nested.run(), /ended/);
  assert.equal(leaf.context.status, 'failed');
  assert.equal(nested.context.status, 'failed');
  assert.equal(root.context.status, 'running');
});

test('execution construction validates before capturing resources or starting child work', async () => {
  const recorder = new Recorder(new RecordBook());
  const runtime = createBoundRuntime({ recorder });
  const failure = new Error('construction rejected');
  let captures = 0;
  assert.throws(
    () =>
      runtime.executionInvocationBuilder.create('input', {
        context: {},
        validate() {
          throw failure;
        },
        establish() {
          captures++;
          return { resources: new ResourceBindings({}) };
        },
        work: { maxRounds: 1, execute: () => assert.fail('must not execute') },
      }),
    (error) => error === failure,
  );
  assert.equal(captures, 0);
  assert.equal([...recorder.book.values()].filter((record) => record.kind === 'execution').length, 0);
  const ready = runtime.executionInvocationBuilder.create('ready', { context: {}, work: identity });
  assert.equal(ready.record, undefined);
  assert.equal(await ready.run(), 'ready');
  assert.equal(ready.record.status, 'succeeded');
});

test('started failure preserves the original error and skips the child record and work', async () => {
  for (const recorded of [false, true]) {
    const recorder = recorded ? new Recorder(new RecordBook()) : undefined;
    const runtime = createBoundRuntime({ recorder });
    const failure = new Error('delivery setup failed');
    let invocation;
    await assert.rejects(
      runtime.executionInvocationBuilder.submit(() => 'input', {
        context: { settings: {} },
        work: { maxRounds: 1, execute: () => assert.fail('must not execute') },
        started: (context, current) => {
          invocation = current;
          assert.equal(context, current.context);
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.equal(invocation.context.status, 'failed');
    assert.equal(invocation.context.state.error, failure);
    assert.equal(invocation.context.progress.round, 0);
    assert.equal(invocation.record, undefined);
    assert.equal(runtime.running, false);
    if (recorder) assert.equal([...recorder.book.values()].filter((record) => record.kind === 'execution').length, 0);
    assert.equal(await runtime.executionInvocationBuilder.submit(() => 'next', { context: { settings: {} }, work: identity }), 'next');
  }
});

test('shared builder capabilities produce independent call event scopes across nested calls and later submissions', async () => {
  const changes = new ChangeBuffer();
  const runtime = createBoundRuntime({ changes });
  const root = runtime.executionInvocationBuilder.create('first', {
    context: { settings },
    work: {
      maxRounds: 1,
      execute(context, parent) {
        return runtime.operationInvocationBuilder
          .create(parent, {
            input: context.input,
            description: operation,
            work: {
              maxRounds: 1,
              execute(context, parent) {
                return runtime.attemptInvocationBuilder.create(parent, { input: context.input, description: attempt, work: identity }).run();
              },
            },
          })
          .run();
      },
    },
  });
  assert.equal(await root.run(), 'first');
  const later = runtime.executionInvocationBuilder.create('later', { context: { settings }, work: identity });
  assert.equal(await later.run(), 'later');
  const events = changes.take().filter((event) => event.type === 'invocation');
  const scopes = Map.groupBy(events, (event) => event.contextId);
  assert.equal(scopes.size, 6); // Two R calls and their E/O/A descendants.
  for (const values of scopes.values()) {
    assert.deepEqual(
      values.map((event) => event.sequence),
      Array.from({ length: values.length }, (_, index) => index + 1),
    );
    assert.equal(values[0].change.kind, 'started');
    assert.equal(values.at(-1).change.status, 'succeeded');
    assert.ok(values.every((event) => Object.isFrozen(event) && Object.isFrozen(event.change)));
  }
  const child = events.find((event) => event.kind === 'group' && event.parentContextId === root.context.id);
  const leaf = events.find((event) => event.kind === 'node');
  assert.equal(child.parentContextId, root.context.id);
  assert.equal(leaf.parentContextId, child.contextId);
  const laterParent = scopes.get(later.context.id)[0].parentContextId;
  assert.equal(scopes.get(laterParent)[0].kind, 'scene');
  assert.notEqual(laterParent, scopes.get(root.context.id)[0].parentContextId);
});

test('a started child checks its own activity instead of reinterpreting manually changed ancestor state', async () => {
  const runtime = createBoundRuntime();
  const root = runtime.executionInvocationBuilder.create('root', { context: { settings }, work: identity });
  const parent = runtime.operationInvocationBuilder.create(root, { input: 'parent', description: operation, work: identity });
  const nested = runtime.operationInvocationBuilder.create(parent, { input: 'nested', description: operation, work: identity });
  let accepted = 0;
  let resume;
  const leaf = runtime.attemptInvocationBuilder.create(nested, {
    input: 'leaf',
    description: attempt,
    work: {
      maxRounds: 1,
      execute: () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
      accept: (_context, output) => {
        accepted++;
        return output;
      },
    },
  });
  const pending = leaf.run();
  // Deliberate construction-level state mutation isolates local activity checks.
  // Normal Invocation completion separately waits for its actual started children.
  parent.context.complete('ended while leaf awaited');
  resume('external result');
  assert.equal(await pending, 'external result');
  assert.equal(accepted, 1);
  assert.equal(leaf.context.status, 'succeeded');
  assert.equal(leaf.context.progress.result.output, 'external result');
  assert.equal(nested.context.status, 'running');
  assert.equal(leaf.context.operationContext, undefined);
  assert.doesNotThrow(() => nested.context.requireActive());
});
