import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, Recorder, RecordBook, createRuntime } from '@capix-observer/runtime';

const signal = () => new AbortController().signal;
const retryWork = {
  maxRounds: 2,
  execute(context, invocation) {
    if (context.progress.round === 1) throw new Error('first round');
    return context.currentInput;
  },
  receive(context, result) {
    if (result.status === 'failed') return context.continueWith('next', 'try again');
    return result.output;
  },
};

test('Invocation owns continuous local sequence across retries, independently of recording', async () => {
  const seen = [];
  const recorded = new Invocation({
    context: new InvocationContext('first'),
    work: retryWork,
    signal: signal(),
    recording: {
      begin(context, bind) {
        bind({ contextId: context.id });
      },
      finish() {},
      process(context, record, process, sequence) {
        seen.push({ round: context.progress.round, type: process.type, sequence });
      },
    },
  });
  const unrecorded = new Invocation({ context: new InvocationContext('first'), work: retryWork, signal: signal() });
  assert.equal(recorded.sequence, 0);
  assert.equal(await recorded.run(), 'next');
  assert.equal(await unrecorded.run(), 'next');
  assert.deepEqual(
    seen.map((item) => item.sequence),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    seen.map((item) => item.round),
    [1, 1, 1, 2, 2, 2],
  );
  assert.equal(recorded.sequence, 6);
  assert.equal(unrecorded.sequence, 6);
});

test('parallel invocations and nested calls keep separate local sequences', async () => {
  const runtime = createRuntime({ recorder: new Recorder(new RecordBook()) });
  let child;
  const root = runtime.executionInvocations.create(
    'input',
    { settings: {} },
    {
      maxRounds: 1,
      async execute(context, invocation) {
        child = runtime.operationInvocations.create(invocation, 'child', { id: 'op', name: 'op', label: 'Op', source: 'test' }, retryWork);
        return child.run();
      },
    },
  );
  const independent = new Invocation({ context: new InvocationContext('other'), signal: signal(), work: { maxRounds: 1, execute: (context) => context.input } });
  await Promise.all([root.run(), independent.run()]);
  assert.equal(root.sequence, 3);
  assert.equal(child.sequence, 6);
  assert.equal(independent.sequence, 3);
  const rootRecord = root.record;
  const childRecord = child.record;
  assert.deepEqual(
    rootRecord.value.processes.map((item) => item.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(
    childRecord.value.processes.map((item) => item.sequence),
    [1, 2, 3, 4, 5, 6],
  );
});

test('failed registration consumes its occurrence position and does not repeat work', async () => {
  let calls = 0;
  const invocation = new Invocation({
    context: new InvocationContext('input'),
    signal: signal(),
    work: {
      maxRounds: 1,
      execute() {
        calls++;
        return 'answer';
      },
    },
    recording: {
      begin(context, bind) {
        bind({ contextId: context.id });
      },
      finish() {},
      process(_context, _record, _process, sequence) {
        if (sequence === 2) throw new Error('cannot record result');
      },
    },
  });
  await assert.rejects(invocation.run(), /cannot record result/);
  assert.equal(invocation.sequence, 2);
  assert.equal(calls, 1);
  await assert.rejects(invocation.run(), /already started/);
  assert.equal(invocation.sequence, 2);
});
