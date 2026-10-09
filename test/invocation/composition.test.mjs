import { bindCallObservation, defineObservation, ResourceBindings } from '@capix-observer/runtime';
import { Operation } from '../fixtures/behavior.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sequence, Invocation, OperationContext, Recorder, RecordBook } from '@capix-observer/runtime';
import { createRuntime } from '../fixtures/runtime.mjs';
import { TestAttempt } from '../fixtures/attempt.mjs';

class ComposedOperation extends Operation {
  name = 'composed';
  label = 'Composed';
  source = 'test';
  constructor(runtime, composition) {
    super(runtime.operationInvocations);
    this.composition = composition;
  }
  execute(context, invocation) {
    return this.composition.run(invocation, context.currentInput);
  }
}

function root(runtime, composition, input = 1) {
  return runtime.executionInvocations.create(input, {
    context: { settings: {} },
    work: { maxRounds: 1, execute: (context, invocation) => composition.run(invocation, context.currentInput) },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test('parent owns a child before it runs and distinguishes its return from parent acceptance', async () => {
  const runtime = createRuntime();
  const entered = deferred();
  const release = deferred();
  const inner = new Sequence().step('leaf', { use: new TestAttempt(runtime, 'leaf', (input) => input + 1), input: ({ input }) => input });
  const operation = new ComposedOperation(runtime, inner);
  const composition = new Sequence().step('work', {
    use: operation,
    input: ({ input, parent }) => {
      assert.equal(parent.children.values().length, 0);
      return input;
    },
    async accept({ parent }, output) {
      const child = parent.children.values()[0];
      assert.equal(child.key, 'work');
      assert.equal(child.invocation.context.status, 'succeeded');
      assert.deepEqual(child.returned, { status: 'succeeded', output: { leaf: 2 } });
      assert.equal(child.reception.status, 'receiving');
      entered.resolve();
      await release.promise;
      return output.leaf * 2;
    },
  });
  const invocation = root(runtime, composition);
  const running = invocation.run();
  await entered.promise;
  assert.equal(invocation.context.status, 'running');
  release.resolve();
  assert.deepEqual(await running, { work: 4 });
  const child = invocation.children.values()[0];
  assert.deepEqual(child.reception, { status: 'accepted', output: 4 });
  assert.equal(child.invocation.children.values()[0].key, 'leaf');
  assert.equal(invocation.record, undefined);
});

test('child failure keeps accepted predecessors and prevents later child creation', async () => {
  const runtime = createRuntime();
  const error = new Error('second failed');
  let observed;
  const first = new TestAttempt(runtime, 'first', (input) => {
    assert.equal(observed.children.values()[0].invocation.context.status, 'running');
    return input;
  });
  const failure = new TestAttempt(runtime, 'failure', () => {
    throw error;
  });
  const sequence = new Sequence()
    .step('first', {
      use: first,
      input: ({ parent, input }) => {
        observed = parent;
        return input;
      },
    })
    .step('second', { use: failure, input: ({ outputs }) => outputs.first })
    .step('third', {
      use: first,
      input: () => {
        assert.fail('must not prepare later input');
      },
    });
  const invocation = root(runtime, new Sequence().step('operation', { use: new ComposedOperation(runtime, sequence), input: ({ input }) => input }));
  await assert.rejects(invocation.run(), (value) => value === error);
  assert.equal(observed.children.values().length, 2);
  assert.equal(observed.children.values()[0].reception.status, 'accepted');
  const failed = observed.children.values()[1].returned;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, error);
  assert.equal(failed.failure.kind, 'error');
  assert.equal(failed.failure.phase, 'execute');
  assert.equal(observed.children.values()[1].reception.status, 'pending');
});

test('parent acceptance failure retains successful child and does not start next work or retry', async () => {
  const runtime = createRuntime();
  let effects = 0;
  const error = new Error('parent append failed');
  const inner = new Sequence().step('leaf', { use: new TestAttempt(runtime, 'leaf', () => ++effects), input: () => null });
  const use = new ComposedOperation(runtime, inner);
  const sequence = new Sequence()
    .step('first', {
      use,
      input: () => null,
      accept: () => {
        throw error;
      },
    })
    .step('second', { use, input: () => null });
  const invocation = root(runtime, sequence);
  await assert.rejects(invocation.run(), (value) => value === error);
  assert.equal(effects, 1);
  const children = invocation.children.values();
  assert.equal(children.length, 1);
  assert.equal(children[0].invocation.context.status, 'succeeded');
  assert.equal(children[0].returned.status, 'succeeded');
  assert.deepEqual(children[0].reception, { status: 'failed', error });
});

test('shared behavior and composition retain independent nested O/O/A relationships per call', async () => {
  const runtime = createRuntime({ recorder: new Recorder(new RecordBook()) });
  const leaf = new TestAttempt(runtime, 'identity');
  const inner = new ComposedOperation(runtime, new Sequence().step('leaf', { use: leaf, input: ({ input }) => input }));
  const outer = new ComposedOperation(runtime, new Sequence().step('inner', { use: inner, input: ({ input }) => input }));
  const sequence = new Sequence().step('outer', { use: outer, input: ({ input }) => input });
  const first = root(runtime, sequence, 'one');
  const second = root(runtime, sequence, 'two');
  assert.deepEqual(await first.run(), { outer: { inner: { leaf: 'one' } } });
  assert.deepEqual(await second.run(), { outer: { inner: { leaf: 'two' } } });
  const outerCall = first.children.values()[0].invocation;
  const innerCall = outerCall.children.values()[0].invocation;
  const leafCall = innerCall.children.values()[0].invocation;
  assert.equal(outerCall.record.parentId, first.record.id);
  assert.equal(innerCall.record.parentId, outerCall.record.id);
  assert.equal(leafCall.record.parentId, innerCall.record.id);
  assert.notEqual(outerCall, second.children.values()[0].invocation);
  assert.equal(outerCall.children.values().length, 1);
});

test('direct calls also attach, without pretending parent acceptance took place', async () => {
  const runtime = createRuntime();
  const operation = new ComposedOperation(runtime, new Sequence());
  const invocation = runtime.executionInvocations.create(null, {
    context: { settings: {} },
    work: { maxRounds: 1, execute: (_context, parent) => operation.call(parent, null) },
  });
  await invocation.run();
  const child = invocation.children.values()[0];
  assert.equal(child.key, undefined);
  assert.equal(child.returned.status, 'succeeded');
  assert.equal(child.reception.status, 'pending');
  assert.throws(() => operation.create(invocation, null), /already ended/);
});

test('a terminal reporting failure remains a failed delivery with a succeeded child context', async () => {
  const runtime = createRuntime();
  const error = new Error('finish record failed');
  const use = {
    create(parent, input, options) {
      return new Invocation({
        parent: { invocation: parent, key: options.key },
        context: new OperationContext(parent.context, input),
        signal: parent.context.signal,
        work: { maxRounds: 1, execute: () => 'completed' },
        observation: bindCallObservation(
          {
            identity: { level: 'operation', contextId: 'delivery-probe' },
            resources: new ResourceBindings({}),
            declarations: [
              defineObservation(
                {
                  requires: {},
                  observe(fact) {
                    if (fact.kind === 'finished') throw error;
                  },
                },
                { failure: 'propagate' },
              ),
            ],
          },
          [],
        ),
      });
    },
  };
  const invocation = root(runtime, new Sequence().step('work', { use, input: () => null }));
  await assert.rejects(invocation.run(), (observed) => observed.code === 'OBSERVATION_FAILED' && observed.cause === error);
  const child = invocation.children.values()[0];
  assert.equal(child.invocation.context.status, 'succeeded');
  assert.equal(child.invocation.context.state.output, 'completed');
  assert.equal(child.returned.status, 'failed');
  assert.equal(child.reception.status, 'pending');
});

test('input preparation failure creates no child and repeated work positions produce separate calls', async () => {
  const runtime = createRuntime();
  const use = new ComposedOperation(runtime, new Sequence());
  const error = new Error('cannot prepare input');
  const failed = root(
    runtime,
    new Sequence().step('work', {
      use,
      input: () => {
        throw error;
      },
    }),
  );
  await assert.rejects(failed.run(), (value) => value === error);
  assert.equal(failed.children.values().length, 0);
  const sequence = new Sequence().step('one', { use, input: () => null }).step('two', { use, input: () => null });
  const invocation = root(runtime, sequence);
  await invocation.run();
  const children = invocation.children.values();
  assert.deepEqual(
    children.map((child) => child.key),
    ['one', 'two'],
  );
  assert.notEqual(children[0].invocation.context, children[1].invocation.context);
  assert.throws(() => sequence.step('one', { use, input: () => null }), /unique/);
});
