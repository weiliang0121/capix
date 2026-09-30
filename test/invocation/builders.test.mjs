import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime, Recorder, RecordBook, Transcript, createRuntime } from '@capix-observer/runtime';

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
  const first = runtime.executionInvocations.create('first', { settings: mutableSettings, signal: firstController.signal }, identity);
  mutableSettings.model = 'next';
  const second = runtime.executionInvocations.create('second', { settings: mutableSettings, signal: secondController.signal }, identity);
  const firstOperation = runtime.operationInvocations.create(first, 'first operation', operation, identity);
  const secondOperation = runtime.operationInvocations.create(second, 'second operation', operation, identity);
  const firstAttempt = runtime.attemptInvocations.create(firstOperation, 'first action', attempt, identity);
  const secondAttempt = runtime.attemptInvocations.create(secondOperation, 'second action', attempt, identity);
  assert.equal(first.context.settings.model, 'fixture');
  assert.equal(second.context.settings.model, 'next');
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
  const root = first.executionInvocations.create('input', { settings }, identity);
  const child = first.operationInvocations.create(root, 'input', operation, identity);
  assert.deepEqual([...recorder.book.values()], [first.record, second.record]);
  assert.throws(() => second.operationInvocations.create(root, 'foreign', operation, identity), /another Runtime/);
  assert.throws(() => second.attemptInvocations.create(child, 'foreign', attempt, identity), /another Runtime/);
  assert.deepEqual([...recorder.book.values()], [first.record, second.record]);
});

test('a constructed call rechecks its parent before entering work, including nested operations', async () => {
  const runtime = createRuntime();
  const root = runtime.executionInvocations.create('root', { settings }, identity);
  const parent = runtime.operationInvocations.create(root, 'parent', operation, identity);
  const forbidden = { maxRounds: 1, execute: () => assert.fail('ended parent must prevent work') };
  const leaf = runtime.attemptInvocations.create(parent, 'leaf', attempt, forbidden);
  const nested = runtime.operationInvocations.create(parent, 'nested', operation, forbidden);
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
    runtime.executionInvocations.submit(() => assert.fail('must not accept'), { settings, transcript: new Transcript() }, identity),
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
      options,
      identity,
    ),
    /another Runtime/,
  );
  assert.equal(runtime.running, false);
  assert.deepEqual([...recorder.book.values()], [runtime.record]);
  const root = runtime.executionInvocations.create('ready', { settings }, identity);
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
      runtime.executionInvocations.submit(
        () => 'input',
        { settings: {} },
        { maxRounds: 1, execute: () => assert.fail('must not execute') },
        (context, current) => {
          invocation = current;
          assert.equal(runtime.running, true);
          assert.equal(context, current.context);
          throw failure;
        },
      ),
      (error) => error === failure,
    );
    assert.equal(invocation.context.status, 'failed');
    assert.equal(invocation.context.state.error, failure);
    assert.equal(invocation.context.progress.round, 0);
    assert.equal(invocation.record, undefined);
    assert.equal(runtime.running, false);
    if (recorder) assert.deepEqual([...recorder.book.values()], before);
    assert.equal(await runtime.executionInvocations.submit(() => 'next', { settings: {} }, identity), 'next');
  }
});
