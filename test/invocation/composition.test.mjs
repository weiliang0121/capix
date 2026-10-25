import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sequence, defineNode, defineGroup, Recorder, RecordBook, bindRecording, defineObservation } from '@capix/server-runtime';
import { runtimeDefinition, recordedCall } from '../fixtures/declarations.mjs';

const metadata = { name: 'composed', label: 'Composed', source: 'test' };
function attempt(name, execute = (value) => value) {
  return defineNode()({ ...metadata, name, run: (work) => execute(work.input) });
}
function composed(sequence) {
  Object.assign(sequence, metadata);
  return sequence;
}
function install(composition, recorder, observations = []) {
  const calls = [];
  const execution = composition;
  const definition = runtimeDefinition(execution);
  const runtime = installCallable(definition, {
    providers: [],
    observations: [...(recorder ? [bindRecording(recorder)] : []), ...observations],
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
  const inner = new Sequence([{ node: attempt('leaf', (input) => input + 1), key: 'leaf' }]);
  const operation = composed(inner);
  let installed;
  const composition = new Sequence([
    {
      node: operation,
      key: 'work',
      input: ({ input }) => {
        assert.equal(installed.calls[0].children.values().length, 0);
        return input;
      },
      result: {
        async succeeded(output, _scope) {
          const child = installed.calls[0].children.values()[0];
          assert.equal(child.key, 'work');
          assert.equal(child.invocation.context.status, 'succeeded');
          assert.deepEqual(child.returned, { status: 'succeeded', output: 2 });
          assert.equal(child.reception.status, 'receiving');
          entered.resolve();
          await release.promise;
          return output * 2;
        },
      },
    },
  ]);
  installed = install(composition);
  const running = installed.runtime.run(1, {});
  await entered.promise;
  const invocation = installed.calls[0];
  assert.equal(invocation.context.status, 'running');
  release.resolve();
  assert.equal(await running, 4);
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
  const sequence = new Sequence([
    { node: first, key: 'first' },
    { node: failure, key: 'second' },
    { node: first, key: 'third', input: () => assert.fail('must not prepare later input') },
  ]);
  const installed = install(new Sequence([{ node: composed(sequence), key: 'operation' }]));
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
  const use = composed(new Sequence([{ node: attempt('leaf', () => ++effects), key: 'leaf', input: () => null }]));
  const sequence = new Sequence([
    {
      node: use,
      key: 'first',
      input: () => null,
      result: {
        succeeded: () => {
          throw error;
        },
      },
    },
    { node: use, key: 'second', input: () => null },
  ]);
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
  const inner = composed(new Sequence([{ node: leaf, key: 'leaf' }]));
  const outer = composed(new Sequence([{ node: inner, key: 'inner' }]));
  const installed = install(new Sequence([{ node: outer, key: 'outer' }]), recorder);
  assert.deepEqual(await installed.runtime.run('one', {}), 'one');
  assert.deepEqual(await installed.runtime.run('two', {}), 'two');
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
  const operation = composed(new Sequence([]));
  let saved;
  let facts;
  const execution = defineGroup()({
    members: [operation],
    run(work) {
      facts = work.children.facts;
      saved = work.children.create(operation, null);
      return saved.run();
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
  const use = defineGroup()({ ...metadata, run: () => 'completed' });
  const declaration = defineObservation(
    {
      deps: {},
      observe(fact) {
        if (fact.kind === 'finished') throw error;
      },
    },
    { failure: 'propagate' },
  );
  const installed = install(new Sequence([{ node: use, key: 'work', input: () => null }]), undefined, [{ bindInvocation: () => ({ observe() {} }), declarations: (structure) => (structure === use ? [declaration] : []) }]);
  await assert.rejects(installed.runtime.run(null, {}), (observed) => observed.code === 'OBSERVATION_FAILED' && observed.cause === error);
  const child = installed.calls[0].children.values()[0];
  assert.equal(child.invocation.context.status, 'succeeded');
  assert.equal(child.invocation.context.state.output, 'completed');
  assert.equal(child.returned.status, 'failed');
  assert.equal(child.reception.status, 'pending');
});

test('input preparation failure creates no child and repeated positions produce separate calls', async () => {
  const use = composed(new Sequence([]));
  const error = new Error('cannot prepare input');
  const failed = install(
    new Sequence([
      {
        node: use,
        key: 'work',
        input: () => {
          throw error;
        },
      },
    ]),
  );
  await assert.rejects(failed.runtime.run(1, {}), (value) => value === error);
  assert.equal(failed.calls[0].children.values().length, 0);
  const repeated = composed(new Sequence([]));
  const sequence = new Sequence([
    { node: repeated, key: 'one', input: () => null },
    { node: repeated, key: 'two', input: () => null },
  ]);
  const installed = install(sequence);
  await installed.runtime.run(1, {});
  const children = installed.calls[0].children.values();
  assert.deepEqual(
    children.map((child) => child.key),
    ['one', 'two'],
  );
  assert.notEqual(children[0].invocation.context, children[1].invocation.context);
  assert.throws(() => sequence.add(repeated), /locked/);
});
