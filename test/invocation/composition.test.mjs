import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sequence, defineNode, defineGroup, Recorder, RecordBook, bindRecording, defineObservation } from '@capix/server-runtime';
import { runtimeDefinition, recordDefinitions, recordedCall } from '../fixtures/declarations.mjs';

const metadata = { name: 'composed', label: 'Composed', source: 'test', callee: 'test' };
function attempt(name, execute = (value) => value) {
  return defineNode()({ ...metadata, name, run: { execute: (work) => execute(work.input) } });
}
function composed(sequence) {
  return defineGroup()({ ...metadata, members: [...new Set(sequence.steps.map((step) => step.use))], run: { execute: (work) => sequence.run(work.input, work.children) } });
}
function install(composition, recorder) {
  const calls = [];
  const execution = defineGroup()({ members: [...new Set(composition.steps.map((step) => step.use))], run: { execute: (work) => composition.run(work.input, work.children) } });
  const definition = runtimeDefinition(execution);
  if (recorder) recordDefinitions(definition);
  const runtime = installCallable(definition, {
    providers: [],
    observations: recorder ? [bindRecording(recorder)] : [],
    source: { capture: () => null },
    bindings: [
      {
        definition: execution,
        started: () => (_context, call) => {
          calls.push(call);
        },
      },
    ],
  });
  return { calls, runtime };
}
function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test('parent owns a child before it runs and distinguishes its return from parent acceptance', async () => {
  const entered = deferred();
  const release = deferred();
  const inner = new Sequence().step('leaf', { use: attempt('leaf', (input) => input + 1), input: ({ input }) => input });
  const operation = composed(inner);
  let installed;
  const composition = new Sequence().step('work', {
    use: operation,
    input: ({ input }) => {
      assert.equal(installed.calls[0].children.values().length, 0);
      return input;
    },
    async accept(_scope, output) {
      const child = installed.calls[0].children.values()[0];
      assert.equal(child.key, 'work');
      assert.equal(child.invocation.context.status, 'succeeded');
      assert.deepEqual(child.returned, { status: 'succeeded', output: { leaf: 2 } });
      assert.equal(child.reception.status, 'receiving');
      entered.resolve();
      await release.promise;
      return output.leaf * 2;
    },
  });
  installed = install(composition);
  const running = installed.runtime.run(1, {});
  await entered.promise;
  const invocation = installed.calls[0];
  assert.equal(invocation.context.status, 'running');
  release.resolve();
  assert.deepEqual(await running, { work: 4 });
  const child = invocation.children.values()[0];
  assert.deepEqual(child.reception, { status: 'accepted', output: 4 });
  assert.equal(child.invocation.children.values()[0].key, 'leaf');
  assert.equal(invocation.record, undefined);
});

test('child failure keeps accepted predecessors and prevents later child creation', async () => {
  const error = new Error('second failed');
  const first = attempt('first');
  const failure = attempt('failure', () => {
    throw error;
  });
  const sequence = new Sequence()
    .step('first', { use: first, input: ({ input }) => input })
    .step('second', { use: failure, input: ({ outputs }) => outputs.first })
    .step('third', { use: first, input: () => assert.fail('must not prepare later input') });
  const installed = install(new Sequence().step('operation', { use: composed(sequence), input: ({ input }) => input }));
  await assert.rejects(installed.runtime.run(1, {}), (value) => value === error);
  const observed = installed.calls[0].children.values()[0].invocation;
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
  let effects = 0;
  const error = new Error('parent append failed');
  const use = composed(new Sequence().step('leaf', { use: attempt('leaf', () => ++effects), input: () => null }));
  const sequence = new Sequence()
    .step('first', {
      use,
      input: () => null,
      accept: () => {
        throw error;
      },
    })
    .step('second', { use, input: () => null });
  const installed = install(sequence);
  await assert.rejects(installed.runtime.run(1, {}), (value) => value === error);
  assert.equal(effects, 1);
  const children = installed.calls[0].children.values();
  assert.equal(children.length, 1);
  assert.equal(children[0].invocation.context.status, 'succeeded');
  assert.equal(children[0].returned.status, 'succeeded');
  assert.equal(children[0].reception.status, 'failed');
  assert.equal(children[0].reception.error, error);
  assert.equal(children[0].reception.failure.kind, 'error');
});

test('shared definitions and composition retain independent O/O/A relationships per call', async () => {
  const recorder = new Recorder(new RecordBook());
  const leaf = attempt('identity');
  const inner = composed(new Sequence().step('leaf', { use: leaf, input: ({ input }) => input }));
  const outer = composed(new Sequence().step('inner', { use: inner, input: ({ input }) => input }));
  const installed = install(new Sequence().step('outer', { use: outer, input: ({ input }) => input }), recorder);
  assert.deepEqual(await installed.runtime.run('one', {}), { outer: { inner: { leaf: 'one' } } });
  assert.deepEqual(await installed.runtime.run('two', {}), { outer: { inner: { leaf: 'two' } } });
  const [first, second] = installed.calls;
  const outerCall = first.children.values()[0].invocation;
  const innerCall = outerCall.children.values()[0].invocation;
  const leafCall = innerCall.children.values()[0].invocation;
  assert.equal(recordedCall(recorder, outerCall).parentId, recordedCall(recorder, first).id);
  assert.equal(recordedCall(recorder, innerCall).parentId, recordedCall(recorder, outerCall).id);
  assert.equal(recordedCall(recorder, leafCall).parentId, recordedCall(recorder, innerCall).id);
  assert.notEqual(outerCall, second.children.values()[0].invocation);
  assert.equal(outerCall.children.values().length, 1);
});

test('direct calls attach and return without pretending parent acceptance took place', async () => {
  const operation = composed(new Sequence());
  let saved;
  let facts;
  const execution = defineGroup()({
    members: [operation],
    run: {
      execute(work) {
        facts = work.children.facts;
        saved = work.children.create(operation, null);
        return saved.run();
      },
    },
  });
  const runtime = installCallable(runtimeDefinition(execution), { providers: [], source: { capture: () => null } });
  await runtime.run(null, {});
  const child = facts.get(saved.ref);
  assert.equal(child.key, undefined);
  assert.equal(child.returned.status, 'succeeded');
  assert.equal(child.reception.status, 'pending');
  await assert.rejects(saved.accept(), /already ended/);
});

test('a terminal reporting failure remains a failed delivery with a succeeded child context', async () => {
  const error = new Error('finish record failed');
  const use = defineGroup()({
    ...metadata,
    observation: [
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
    run: { execute: () => 'completed' },
  });
  const installed = install(new Sequence().step('work', { use, input: () => null }));
  await assert.rejects(installed.runtime.run(null, {}), (observed) => observed.code === 'OBSERVATION_FAILED' && observed.cause === error);
  const child = installed.calls[0].children.values()[0];
  assert.equal(child.invocation.context.status, 'succeeded');
  assert.equal(child.invocation.context.state.output, 'completed');
  assert.equal(child.returned.status, 'failed');
  assert.equal(child.reception.status, 'pending');
});

test('input preparation failure creates no child and repeated positions produce separate calls', async () => {
  const use = composed(new Sequence());
  const error = new Error('cannot prepare input');
  const failed = install(
    new Sequence().step('work', {
      use,
      input: () => {
        throw error;
      },
    }),
  );
  await assert.rejects(failed.runtime.run(1, {}), (value) => value === error);
  assert.equal(failed.calls[0].children.values().length, 0);
  const sequence = new Sequence().step('one', { use, input: () => null }).step('two', { use, input: () => null });
  const installed = install(sequence);
  await installed.runtime.run(1, {});
  const children = installed.calls[0].children.values();
  assert.deepEqual(
    children.map((child) => child.key),
    ['one', 'two'],
  );
  assert.notEqual(children[0].invocation.context, children[1].invocation.context);
  assert.throws(() => sequence.step('one', { use, input: () => null }), /unique/);
});
