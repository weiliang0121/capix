import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceOffer, MemoryCheckpointStore, checkpointPoint, assembleRuntime } from '@capix/server-runtime';
import { runtimeDefinition } from './fixtures/declarations.mjs';

function assemble(definition, options = {}) {
  return assembleRuntime(definition, { providers: [], source: { entry: () => null, capture: () => null }, ...options });
}

test('assembled work preserves absent acceptance as a reuse fact instead of inserting an identity receiver', async () => {
  for (const explicit of [false, true]) {
    const output = { answer: 'original object' };
    const processes = [];
    let accepted = 0;
    const run = {
      requires: {},
      execute(work) {
        for (const key of ['access', 'invocation', 'options', 'context', 'complete']) assert.equal(key in work, false);
        for (const key of ['access', 'work', 'parent', 'calls']) assert.equal(key in work.children, false);
        return output;
      },
    };
    if (explicit) {
      run.accept = ({ delivered: value }) => {
        accepted++;
        assert.equal(value, output);
        return value;
      };
    }
    const definition = { level: 'runtime', maxRounds: 1, raises: [], children: [], run };
    const runtime = assemble(definition, {
      observations: [
        {
          bindInvocation() {
            return {
              observe(fact) {
                if (fact.kind === 'process') processes.push(fact.process);
              },
            };
          },
        },
      ],
    });
    assert.equal(await runtime.run(null, {}), output);
    assert.equal(accepted, explicit ? 1 : 0);
    const receive = processes.filter((process) => process.stage === 'receive');
    assert.equal(receive.length, 1);
    assert.equal(receive[0].type, 'return');
    if (explicit) {
      assert.equal(receive[0].output, output);
      assert.equal('reuse' in receive[0], false);
    } else {
      assert.equal(receive[0].reuse, true);
      assert.equal('output' in receive[0], false);
    }
  }
});

test('overlapping calls through one bound O retain independent access and child deliveries across run and accept', async () => {
  const pending = new Map();
  const calls = new Map();
  const accepted = [];
  const scopes = new Map();
  let exposed = 0;
  const resource = new ResourceOffer('test.invocationAccess.owner', (_value, activity) => {
    exposed++;
    const token = {};
    return { token, touch: () => activity.runSync('touch', {}, () => token) };
  });
  const requires = { owner: resource.request() };
  const leaf = {
    level: 'attempt',
    name: 'await-result',
    label: 'Await result',
    source: 'test',
    callee: 'test',
    maxRounds: 1,
    raises: [],
    run: { requires: {}, execute: (work) => new Promise((resolve) => pending.set(work.input, resolve)) },
  };
  const operation = {
    level: 'operation',
    name: 'overlap',
    label: 'Overlap',
    source: 'test',
    maxRounds: 1,
    raises: [],
    children: [leaf],
    run: {
      requires,
      async execute(work) {
        const owner = work.resources.owner;
        const call = work.children.create(leaf, work.input);
        scopes.set(work.input, { work, owner });
        calls.set(work.input, call.ref);
        return call.run();
      },
      accept(work) {
        const previous = scopes.get(work.input);
        assert.notEqual(work, previous.work);
        assert.notEqual(work.children, previous.work.children);
        assert.equal(work.resources.owner, previous.owner);
        assert.equal(work.resources.owner.touch(), previous.owner.token);
        const ref = calls.get(work.input);
        return work.children.open(ref).accept((value) => {
          assert.equal(value, work.delivered);
          assert.equal(work.children.facts.get(ref).reception.status, 'receiving');
          accepted.push(work.input);
          return value;
        });
      },
    },
  };
  const execution = {
    level: 'execution',
    maxRounds: 1,
    raises: [],
    children: [operation],
    run: {
      requires,
      async execute(work) {
        const first = work.children.create(operation, 'first');
        const second = work.children.create(operation, 'second');
        const firstResult = first.run();
        const secondResult = second.run();
        firstResult.catch(() => {});
        try {
          assert.equal(pending.size, 2);
          assert.equal(exposed, 2);
          const owners = [...scopes.values()].map((scope) => scope.owner);
          assert.notEqual(owners[0], owners[1]);
          pending.get('second')({ answer: 'second result' });
          await secondResult;
          assert.deepEqual(accepted, ['second']);
          pending.get('first')({ answer: 'first result' });
          await firstResult;
          const firstOutput = await first.accept();
          const secondOutput = await second.accept();
          return [firstOutput.answer, secondOutput.answer];
        } finally {
          for (const resolve of pending.values()) resolve({ answer: 'cleanup' });
          await Promise.allSettled([firstResult, secondResult]);
        }
      },
    },
  };
  const runtime = assemble(runtimeDefinition(execution), { providers: [resource.provide(() => null)] });
  assert.equal(exposed, 0);
  assert.deepEqual(await runtime.run(null, {}), ['first result', 'second result']);
  assert.deepEqual(accepted, ['second', 'first']);
  assert.equal(exposed, 2);
});

test('checkpoint continuation hands its child delivery to normal acceptance with the correct phase resource view', async () => {
  const realized = [];
  const normal = new ResourceOffer('test.invocationAccess.normal', () => {
    realized.push('normal');
    return 'normal access';
  });
  const continuation = new ResourceOffer('test.invocationAccess.continuation', () => {
    realized.push('continuation');
    return 'continuation access';
  });
  const child = { level: 'execution', maxRounds: 1, raises: [], children: [], run: { requires: {}, execute: () => ({ answer: 'child output' }) } };
  const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
  let call;
  let previous;
  const definition = {
    level: 'runtime',
    maxRounds: 1,
    raises: [],
    children: [child],
    run: {
      requires: { normal: normal.request() },
      uses: [],
      execute: () => assert.fail('normal execute must not replay'),
      accept(work) {
        assert.notEqual(work, previous);
        assert.notEqual(work.children, previous.children);
        assert.deepEqual(Object.keys(work.resources), ['normal']);
        assert.deepEqual(realized, ['continuation']);
        assert.equal(work.resources.normal, 'normal access');
        assert.equal(work.checkpoint, undefined);
        assert.equal(work.output, undefined);
        return work.children.open(call.ref).accept((value) => {
          assert.equal(value, work.delivered);
          return value.answer;
        });
      },
    },
    checkpoint: {
      key: 'test.invocationAccess.resume',
      version: 1,
      input: codec,
      output: codec,
      points: [
        checkpointPoint()({
          name: 'saved',
          state: codec,
          references: {},
          resume: {
            requires: { continuation: continuation.request() },
            uses: [child],
            execute(work) {
              assert.deepEqual(realized, []);
              assert.deepEqual(Object.keys(work.resources), ['continuation']);
              assert.equal(work.resources.continuation, 'continuation access');
              assert.ok(work.checkpoint);
              previous = work;
              call = work.children.create(child, null);
              return call.run();
            },
          },
        }),
      ],
    },
  };
  const store = new MemoryCheckpointStore();
  store.save({ id: 'saved-access', formatVersion: 2, contract: { key: definition.checkpoint.key, version: 1 }, point: 'saved', frame: { owner: { contextId: 'restored-access', level: 'runtime' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] }, state: null, references: {} }, 0);
  const runtime = assemble(definition, { checkpoints: { store }, providers: [normal.provide(() => null), continuation.provide(() => null)], source: { runtime: () => null, entry: () => null, capture: () => null } });
  assert.deepEqual(realized, []);
  assert.equal(await runtime.resume('restored-access', {}), 'child output');
  assert.deepEqual(realized, ['continuation', 'normal']);
  assert.equal(store.read('restored-access').delivery.output, 'child output');
});
