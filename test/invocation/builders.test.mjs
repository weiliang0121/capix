import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime, Recorder, RecordBook, Transcript, ChangeObserver, createRuntime, bindResources, ResourceOffer } from '@capix-observer/runtime';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const operation = { id: 'operation', name: 'work', label: 'Work', source: 'test' };
const attempt = { name: 'action', label: 'Action', source: 'test', callee: 'processing' };
const identity = { maxRounds: 1, execute: (context) => context.currentInput };

test('reused builders bind each invocation to its own signal, settings and input', async () => {
  const runtime = createRuntime();
  const builders = [runtime.executionInvocations, runtime.operationInvocations, runtime.attemptInvocations];
  const firstController = new AbortController();
  const secondController = new AbortController();
  const mutableSettings = { ...settings };
  const configuration = new ResourceOffer('test.settings', (source) => source);
  const requires = { settings: configuration.request() };
  const resourceBinding = bindResources(requires, [configuration.provide((source) => source.settings)]);
  const first = runtime.executionInvocations.create('first', { requires, resourceBinding, context: { settings: mutableSettings, signal: firstController.signal }, work: identity });
  mutableSettings.model = 'next';
  const second = runtime.executionInvocations.create('second', { requires, resourceBinding, context: { settings: mutableSettings, signal: secondController.signal }, work: identity });
  const firstOperation = runtime.operationInvocations.create(first, { input: 'first operation', description: operation, work: identity });
  const secondOperation = runtime.operationInvocations.create(second, { input: 'second operation', description: operation, work: identity });
  const firstAttempt = runtime.attemptInvocations.create(firstOperation, { input: 'first action', description: attempt, work: identity });
  const secondAttempt = runtime.attemptInvocations.create(secondOperation, { input: 'second action', description: attempt, work: identity });
  assert.equal(first.context.resources.values.settings.model, 'fixture');
  assert.equal(second.context.resources.values.settings.model, 'next');
  assert.equal(firstAttempt.context.signal, firstController.signal);
  assert.equal(secondAttempt.context.signal, secondController.signal);
  assert.equal(first.context.runtime, undefined);
  assert.equal(first.context.progress.round, 0);
  const cause = new Error('first only');
  firstController.abort(cause);
  await assert.rejects(firstAttempt.run(), (error) => error.code === 'INVOCATION_CANCELLED' && error.cause === cause);
  assert.equal(await secondAttempt.run(), 'second action');
  assert.equal(secondController.signal.aborted, false);
  assert.deepEqual([runtime.executionInvocations, runtime.operationInvocations, runtime.attemptInvocations], builders);
});

test('construction writes no call records and rejects foreign contexts before starting work', () => {
  const recorder = new Recorder(new RecordBook());
  const first = createRuntime({ recorder });
  const second = createRuntime({ recorder });
  const root = first.executionInvocations.create('input', { context: { settings }, work: identity });
  const child = first.operationInvocations.create(root, { input: 'input', description: operation, work: identity });
  assert.deepEqual([...recorder.book.values()], [first.record, second.record]);
  assert.throws(() => second.operationInvocations.create(root, { input: 'foreign', description: operation, work: identity }), /another Runtime/);
  assert.throws(() => second.attemptInvocations.create(child, { input: 'foreign', description: attempt, work: identity }), /another Runtime/);
  assert.deepEqual([...recorder.book.values()], [first.record, second.record]);
});

test('a constructed call rechecks its parent before entering work, including nested operations', async () => {
  const runtime = createRuntime();
  const root = runtime.executionInvocations.create('root', { context: { settings }, work: identity });
  const parent = runtime.operationInvocations.create(root, { input: 'parent', description: operation, work: identity });
  const forbidden = { maxRounds: 1, execute: () => assert.fail('ended parent must prevent work') };
  const leaf = runtime.attemptInvocations.create(parent, { input: 'leaf', description: attempt, work: forbidden });
  const nested = runtime.operationInvocations.create(parent, { input: 'nested', description: operation, work: forbidden });
  parent.context.complete('done');
  await assert.rejects(leaf.run(), /ended/);
  await assert.rejects(nested.run(), /ended/);
  assert.equal(leaf.context.status, 'failed');
  assert.equal(nested.context.status, 'failed');
  assert.equal(root.context.status, 'running');
});

test('entry validates before accepting input and releases its reservation after construction failure', async () => {
  const recorder = new Recorder(new RecordBook());
  const runtime = createRuntime({ recorder });
  await assert.rejects(
    runtime.executionInvocations.submit(() => assert.fail('must not accept'), { context: { settings, transcript: new Transcript() }, work: identity }),
    /another Runtime/,
  );
  const options = { settings };
  await assert.rejects(
    runtime.executionInvocations.submit(
      () => {
        // Conditions may change during external input acceptance; creation checks them again.
        options.transcript = new Transcript();
        return 'input';
      },
      { context: options, work: identity },
    ),
    /another Runtime/,
  );
  assert.equal(runtime.running, false);
  assert.deepEqual([...recorder.book.values()], [runtime.record]);
  const root = runtime.executionInvocations.create('ready', { context: { settings }, work: identity });
  assert.deepEqual([...recorder.book.values()], [runtime.record]);
  assert.equal(await root.run(), 'ready');
  assert.equal([...recorder.book.values()].length, 4); // Runtime + execution + two boundary events.
});

test('started failure preserves the original error, skips recording and work, and releases Runtime reservation', async () => {
  for (const recorded of [false, true]) {
    const recorder = recorded ? new Recorder(new RecordBook()) : undefined;
    const runtime = createRuntime({ recorder });
    const before = recorder ? [...recorder.book.values()] : [];
    const failure = new Error('delivery setup failed');
    let invocation;
    await assert.rejects(
      runtime.executionInvocations.submit(() => 'input', {
        context: { settings: {} },
        work: { maxRounds: 1, execute: () => assert.fail('must not execute') },
        started: (context, current) => {
          invocation = current;
          assert.equal(runtime.running, true);
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
    if (recorder) assert.deepEqual([...recorder.book.values()], before);
    assert.equal(await runtime.executionInvocations.submit(() => 'next', { context: { settings: {} }, work: identity }), 'next');
  }
});

test('shared builder capabilities produce independent call event scopes across nested calls and later submissions', async () => {
  const changes = new ChangeObserver();
  const runtime = createRuntime({ changes });
  const root = runtime.executionInvocations.create('first', {
    context: { settings },
    work: {
      maxRounds: 1,
      execute(context, parent) {
        return runtime.operationInvocations
          .create(parent, {
            input: context.input,
            description: operation,
            work: {
              maxRounds: 1,
              execute(context, parent) {
                return runtime.attemptInvocations.create(parent, { input: context.input, description: attempt, work: identity }).run();
              },
            },
          })
          .run();
      },
    },
  });
  assert.equal(await root.run(), 'first');
  const later = runtime.executionInvocations.create('later', { context: { settings }, work: identity });
  assert.equal(await later.run(), 'later');
  const events = changes.take().filter((event) => event.type === 'invocation');
  const scopes = Map.groupBy(events, (event) => event.contextId);
  assert.equal(scopes.size, 4);
  for (const values of scopes.values()) {
    assert.deepEqual(
      values.map((event) => event.sequence),
      [1, 2, 3, 4, 5],
    );
    assert.equal(values[0].change.kind, 'started');
    assert.equal(values.at(-1).change.status, 'succeeded');
    assert.ok(values.every((event) => Object.isFrozen(event) && Object.isFrozen(event.change)));
  }
  const child = events.find((event) => event.level === 'operation');
  const leaf = events.find((event) => event.level === 'attempt');
  assert.equal(child.parentContextId, root.context.id);
  assert.equal(leaf.parentContextId, child.contextId);
  assert.equal(scopes.get(later.context.id)[0].parentContextId, undefined);
});

test('a completed ancestor stops an awaiting child before receive without exposing parent contexts', async () => {
  const runtime = createRuntime();
  const root = runtime.executionInvocations.create('root', { context: { settings }, work: identity });
  const parent = runtime.operationInvocations.create(root, { input: 'parent', description: operation, work: identity });
  const nested = runtime.operationInvocations.create(parent, { input: 'nested', description: operation, work: identity });
  let resume;
  const leaf = runtime.attemptInvocations.create(nested, {
    input: 'leaf',
    description: attempt,
    work: {
      maxRounds: 1,
      execute: () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
      receive: () => assert.fail('an ended ancestor must prevent receive'),
    },
  });
  const pending = leaf.run();
  parent.context.complete('ended while leaf awaited');
  resume('external result');
  await assert.rejects(pending, /ended/);
  assert.equal(leaf.context.status, 'failed');
  assert.equal(leaf.context.progress.result.output, 'external result');
  assert.equal(nested.context.status, 'running');
  assert.equal(leaf.context.operationContext, undefined);
  assert.throws(() => nested.context.requireActive(), /ended/);
});
