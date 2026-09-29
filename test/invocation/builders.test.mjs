import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runtime, RuntimeRecorder, RecordBook, Transcript } from '@capix-observer/runtime';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const operation = { id: 'operation', name: 'work', label: 'Work', source: 'test' };
const attempt = { name: 'action', label: 'Action', source: 'test', callee: 'processing' };
const identity = { maxRounds: 1, execute: (context) => context.currentInput };

test('reused builders bind each invocation to its own signal, settings and input', async () => {
  const runtime = new Runtime();
  const builders = [runtime.executionInvocations, runtime.operationInvocations, runtime.attemptInvocations];
  const firstController = new AbortController();
  const secondController = new AbortController();
  const mutableSettings = { ...settings };
  const first = runtime.executionInvocations.create('first', { settings: mutableSettings, signal: firstController.signal }, identity);
  mutableSettings.model = 'next';
  const second = runtime.executionInvocations.create('second', { settings: mutableSettings, signal: secondController.signal }, identity);
  const firstOperation = runtime.operationInvocations.create(first.context, 'first operation', operation, identity);
  const secondOperation = runtime.operationInvocations.create(second.context, 'second operation', operation, identity);
  const firstAttempt = runtime.attemptInvocations.create(firstOperation.context, 'first action', attempt, identity);
  const secondAttempt = runtime.attemptInvocations.create(secondOperation.context, 'second action', attempt, identity);
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
  const recorder = new RuntimeRecorder(new RecordBook());
  const first = new Runtime({ recorder });
  const second = new Runtime({ recorder });
  const root = first.executionInvocations.create('input', { settings }, identity);
  const child = first.operationInvocations.create(root.context, 'input', operation, identity);
  assert.equal([...recorder.book.values()].length, 0);
  assert.throws(() => second.operationInvocations.create(root.context, 'foreign', operation, identity), /another Runtime/);
  assert.throws(() => second.attemptInvocations.create(child.context, 'foreign', attempt, identity), /another Runtime/);
  assert.equal([...recorder.book.values()].length, 0);
});

test('a constructed call rechecks its parent before entering work, including nested operations', async () => {
  const runtime = new Runtime();
  const root = runtime.executionInvocations.create('root', { settings }, identity);
  const parent = runtime.operationInvocations.create(root.context, 'parent', operation, identity);
  const forbidden = { maxRounds: 1, execute: () => assert.fail('ended parent must prevent work') };
  const leaf = runtime.attemptInvocations.create(parent.context, 'leaf', attempt, forbidden);
  const nested = runtime.operationInvocations.create(root.context, 'nested', operation, forbidden, parent.context);
  parent.context.complete('done');
  await assert.rejects(leaf.run(), /ended/);
  await assert.rejects(nested.run(), /ended/);
  assert.equal(leaf.context.status, 'failed');
  assert.equal(nested.context.status, 'failed');
  assert.equal(root.context.status, 'running');
});

test('entry validates before accepting input and releases its reservation after construction failure', async () => {
  const recorder = new RuntimeRecorder(new RecordBook());
  const runtime = new Runtime({ recorder });
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
  assert.equal([...recorder.book.values()].length, 0);
  const root = runtime.executionInvocations.create('ready', { settings }, identity);
  assert.equal([...recorder.book.values()].length, 0);
  assert.equal(await root.run(), 'ready');
  assert.equal([...recorder.book.values()].length, 3);
});
