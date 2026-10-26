import { observeCall } from '../fixtures/observation.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, ExceptionContract } from '@capix/server-runtime';
import { Recorder, RecordBook } from '@capix/records';
import { createBoundRuntime } from '../fixtures/runtime.mjs';

const signal = () => new AbortController().signal;
const businessWork = {
  execute(context) {
    let value = context.input;
    for (let index = 0; index < 2; index++) value = 'next';
    return value;
  },
};

test('Invocation sequences describe its entry and return, not internal business iterations', async () => {
  const seen = [];
  const recorded = new Invocation({
    context: new InvocationContext('first'),
    work: businessWork,
    signal: signal(),
    observation: observeCall((fact) => {
      if (fact.kind === 'process') seen.push({ round: fact.round, sequence: fact.processSequence });
    }),
  });
  const unrecorded = new Invocation({ context: new InvocationContext('first'), work: businessWork, signal: signal() });
  assert.equal(await recorded.run(), 'next');
  assert.equal(await unrecorded.run(), 'next');
  assert.deepEqual(seen, [
    { round: 1, sequence: 1 },
    { round: 1, sequence: 2 },
  ]);
  assert.equal(recorded.sequence, 2);
  assert.equal(unrecorded.sequence, 2);
});

test('parallel and nested invocations maintain separate local process sequences', async () => {
  let child;
  const root = new Invocation({
    context: new InvocationContext('root'),
    signal: signal(),
    work: {
      execute(_context, parent) {
        child = new Invocation({ context: new InvocationContext('child'), signal: signal(), parent: { invocation: parent }, work: businessWork });
        return child.run();
      },
    },
  });
  const independent = new Invocation({ context: new InvocationContext('other'), signal: signal(), work: businessWork });
  await Promise.all([root.run(), independent.run()]);
  assert.equal(root.sequence, 2);
  assert.equal(child.sequence, 2);
  assert.equal(independent.sequence, 2);
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
    observation: observeCall((fact) => {
      if (fact.kind === 'process' && fact.processSequence === 2) throw new Error('cannot record result');
    }),
  });
  await assert.rejects(invocation.run(), (error) => error.cause?.message === 'cannot record result');
  assert.equal(invocation.sequence, 2);
  assert.equal(calls, 1);
  await assert.rejects(invocation.run(), /already started/);
  assert.equal(invocation.sequence, 2);
});
