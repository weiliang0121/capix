import { observeCall } from '../fixtures/observation.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, ExecutionContext, ExceptionContract, Recorder, RecordBook, ExecutionRecordHelper, invocationRecording } from '@capix/server-runtime';
import { createBoundRuntime } from '../fixtures/runtime.mjs';
import { readOutput, validateExecutionRecordSnapshot } from '@capix/protocol';

const rejected = new ExceptionContract('TEST_OUTPUT_REJECTED');
const make = (work, extra = {}) => new Invocation({ context: new InvocationContext('input'), signal: new AbortController().signal, work: { maxRounds: 1, ...work }, ...extra });
const handlers = (handle) => ({ accepts: [rejected], handle });

test('an explicit producer exception reaches its matching handler without records', async () => {
  const cause = new Error('invalid output');
  const facts = { output: 'bad' };
  const exception = rejected.create('rejected', facts, { cause });
  let handled = 0;
  const call = make({
    raises: [rejected],
    execute() {
      throw exception;
    },
    exceptions: handlers((context, received) => {
      handled++;
      assert.equal(context.progress.phase, 'handling');
      assert.equal(received, exception);
      assert.equal(received.facts, facts);
      assert.equal(received.cause, cause);
      return { kind: 'return', output: 'fallback' };
    }),
  });
  assert.equal(await call.run(), 'fallback');
  assert.equal(handled, 1);
  assert.equal(call.failure, undefined);
  assert.equal(call.context.status, 'succeeded');
});

test('unknown throws and undeclared or identity-mismatched exceptions cannot enter handling', async () => {
  const unknown = new Error('bug');
  const undeclared = rejected.create('missing raises', {});
  for (const thrown of [unknown, undeclared]) {
    const call = make({
      execute() {
        throw thrown;
      },
      exceptions: handlers(() => assert.fail('must not handle')),
    });
    await assert.rejects(call.run(), (error) => (thrown === unknown ? error === unknown : error.code === 'UNDECLARED_EXCEPTION' && error.cause === undeclared));
    assert.equal(call.failure.kind, 'error');
  }
  const otherIdentity = new ExceptionContract(rejected.name);
  const exception = rejected.create('known but not accepted here', {});
  const call = make({
    raises: [rejected],
    execute() {
      throw exception;
    },
    exceptions: { accepts: [otherIdentity], handle: () => assert.fail('identity differs') },
  });
  await assert.rejects(call.run(), (error) => error === exception);
  assert.equal(call.failure.kind, 'exception');
});

test('a failed child may deliver a declared exception to its direct parent handler', async () => {
  const exception = rejected.create('rejected', {});
  let child;
  const parent = make({
    execute: async (_context, owner) => {
      child = make(
        {
          raises: [rejected],
          execute() {
            throw exception;
          },
        },
        { parent: { invocation: owner } },
      );
      return child.run();
    },
    exceptions: handlers(() => ({ kind: 'return', output: 'accepted fallback' })),
  });
  assert.equal(await parent.run(), 'accepted fallback');
  assert.equal(child.context.status, 'failed');
  assert.equal(child.failure.kind, 'exception');
  assert.equal(parent.children.values()[0].returned.failure.kind, 'exception');
});

test('catching child errors cannot erase or relabel the error delivery', async () => {
  const error = new Error('child structure failed');
  for (const relabel of [false, true]) {
    const parent = make({
      raises: [rejected],
      execute: async (_context, owner) => {
        try {
          await make(
            {
              execute() {
                throw error;
              },
            },
            { parent: { invocation: owner } },
          ).run();
        } catch {
          if (relabel) throw rejected.create('pretend expected', {});
        }
        return 'pretend success';
      },
      exceptions: handlers(() => assert.fail('cannot handle a child error')),
    });
    await assert.rejects(parent.run(), (actual) => actual === error);
    assert.equal(parent.failure.kind, 'error');
    assert.equal(parent.context.status, 'failed');
  }
});

test('handler failure and malformed decisions terminate once without recursive handling', async () => {
  const exception = rejected.create('bad output', {});
  for (const action of [
    () => {
      throw new Error('handler bug');
    },
    () => ({ kind: 'retry' }),
    () => ({ kind: 'return' }),
    () => ({ kind: 'continue', input: 'next', reason: ' ' }),
    () => {
      throw exception;
    },
  ]) {
    let calls = 0;
    const call = make({
      raises: [rejected],
      execute() {
        throw exception;
      },
      exceptions: handlers(() => {
        calls++;
        return action();
      }),
    });
    await assert.rejects(call.run());
    assert.equal(calls, 1);
    assert.equal(call.failure.kind, 'error');
    assert.equal(call.failure.phase, 'handling');
  }
});

test('a caught formal endpoint error also prevents a handler fallback', async () => {
  const failure = new Error('endpoint failed');
  const call = make({
    raises: [rejected],
    execute() {
      throw rejected.create('rejected', {});
    },
    exceptions: handlers((_context, _exception, owner) => {
      try {
        owner.reject(failure);
        throw failure;
      } catch {}
      return { kind: 'return', output: 'fallback' };
    }),
  });
  await assert.rejects(call.run(), (error) => error === failure);
  assert.equal(call.failure.kind, 'error');
});

test('an acceptance exception is handled separately from normal output acceptance', async () => {
  const output = { value: 'raw' };
  let accepted = 0;
  const call = make({
    raises: [rejected],
    execute: () => output,
    accept(_context, actual) {
      assert.equal(actual, output);
      accepted++;
      throw rejected.create('cannot accept', { output });
    },
    exceptions: handlers(() => ({ kind: 'return', output: 'alternate' })),
  });
  assert.equal(await call.run(), 'alternate');
  assert.equal(accepted, 1);
  assert.equal(call.context.progress.result.output, output);
});

test('handled continuation keeps one owner and creates a new work round', async () => {
  const inputs = [];
  const call = make({
    maxRounds: 2,
    raises: [rejected],
    execute(context) {
      inputs.push(context.currentInput);
      if (inputs.length === 1) throw rejected.create('retry declared output', {});
      return 'done';
    },
    exceptions: handlers(() => ({ kind: 'continue', input: 'corrected', reason: 'explicit correction' })),
  });
  assert.equal(await call.run(), 'done');
  assert.deepEqual(inputs, ['input', 'corrected']);
  assert.equal(call.context.input, 'input');
});

test('successful child context and failed final delivery remain distinct', async () => {
  let child;
  const failure = new Error('record finish failed');
  const parent = make({
    execute: async (_context, owner) => {
      child = make(
        { execute: () => 'created effect' },
        {
          parent: { invocation: owner },
          observation: observeCall((fact) => {
            if (fact.kind === 'finished') throw failure;
          }),
        },
      );
      try {
        await child.run();
      } catch {}
      return 'pretend success';
    },
  });
  await assert.rejects(parent.run(), (error) => error.code === 'OBSERVATION_FAILED' && error.cause === failure);
  assert.equal(child.context.status, 'succeeded');
  assert.equal(child.failure.kind, 'error');
  assert.equal(child.failure.phase, 'observation');
  assert.equal(parent.context.status, 'failed');
});

test('record-only IO descriptions preserve live values and handling output references', async () => {
  const runtime = createBoundRuntime({ recorder: new Recorder(new RecordBook()) });
  const input = { text: 'original', internal: new Map() };
  const output = { text: 'fallback', internal: new Map() };
  const call = runtime.executionInvocationBuilder.create(input, {
    context: {},
    observation: [invocationRecording({ input: (value) => ({ text: value.text }), output: (value) => ({ text: value.text }) })],
    work: {
      maxRounds: 1,
      raises: [rejected],
      execute(current) {
        assert.equal(current.input, input);
        throw rejected.create('expected', null);
      },
      exceptions: handlers(() => ({ kind: 'return', output })),
    },
  });
  const context = call.context;
  assert.equal(await call.run(), output);
  assert.equal(context.state.output, output);
  const snapshot = ExecutionRecordHelper.snapshot(runtime.recorder, call.record.id);
  validateExecutionRecordSnapshot(snapshot);
  assert.deepEqual(snapshot.execution.value.input, { text: 'original' });
  assert.deepEqual(readOutput(snapshot.execution.value), { text: 'fallback' });
  assert.equal(snapshot.execution.value.processes.at(-1).stage, 'handling');
});

test('failed record delivery exposes error category without live failure objects', async () => {
  const runtime = createBoundRuntime({ recorder: new Recorder(new RecordBook()) });
  const exception = rejected.create('expected rejection', { value: 1 });
  const call = runtime.executionInvocationBuilder.create('input', {
    context: {},
    work: {
      maxRounds: 1,
      raises: [rejected],
      execute() {
        throw exception;
      },
    },
  });
  const context = call.context;
  await assert.rejects(call.run(), (error) => error === exception);
  const snapshot = ExecutionRecordHelper.snapshot(runtime.recorder, call.record.id);
  validateExecutionRecordSnapshot(snapshot);
  assert.deepEqual(snapshot.execution.value.failure, { kind: 'exception', phase: 'execute', contextId: context.id, contract: rejected.name });
  assert.equal(Object.hasOwn(snapshot.execution.value.processes.at(-1).failure, 'error'), false);
});

test('a repeated child entry is a parent error even if the first child call succeeded', async () => {
  let child;
  const parent = make({
    execute: async (_context, owner) => {
      child = make({ execute: () => 'once' }, { parent: { invocation: owner } });
      await child.callView.run();
      try {
        await child.callView.run();
      } catch {}
      return 'ignored duplicate entry';
    },
  });
  await assert.rejects(parent.run(), /already started/);
  assert.equal(child.context.status, 'succeeded');
  assert.equal(parent.failure.kind, 'error');
  assert.equal(parent.children.values()[0].returned.status, 'succeeded');
});

test('a preconstructed child cannot start work after its parent has an error', async () => {
  let effects = 0;
  const parent = make({
    execute: async (_context, owner) => {
      const next = make(
        {
          execute: () => {
            effects++;
            return 'effect';
          },
        },
        { parent: { invocation: owner } },
      );
      try {
        await make(
          {
            execute() {
              throw new Error('first failed');
            },
          },
          { parent: { invocation: owner } },
        ).run();
      } catch {}
      try {
        await next.callView.run();
      } catch {}
      return 'done';
    },
  });
  await assert.rejects(parent.run(), /first failed/);
  assert.equal(effects, 0);
});
