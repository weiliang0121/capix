import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceOffer, MemoryCheckpointStore, assembleRuntime } from '@capix/server-runtime';
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
      execute(context, invocation, children) {
        for (const key of ['access', 'work', 'invocation', 'options']) assert.equal(key in invocation, false);
        for (const key of ['access', 'work', 'invocation', 'complete']) assert.equal(key in context, false);
        for (const key of ['access', 'work', 'parent', 'calls']) assert.equal(key in children, false);
        return output;
      },
    };
    if (explicit) {
      run.accept = (_context, value) => {
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
    run: { requires: {}, execute: (context) => new Promise((resolve) => pending.set(context.currentInput, resolve)) },
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
      async execute(context, invocation, children) {
        const owner = context.resources.values.owner;
        const call = children.get(leaf).create(invocation, context.currentInput);
        scopes.set(context.id, { context, invocation, children, owner });
        calls.set(context.id, call);
        return call.run();
      },
      accept(context, output, invocation, children) {
        const previous = scopes.get(context.id);
        assert.notEqual(context, previous.context);
        assert.notEqual(invocation, previous.invocation);
        assert.notEqual(children, previous.children);
        assert.equal(context.resources.values.owner, previous.owner);
        assert.equal(context.resources.values.owner.touch(), previous.owner.token);
        return children.accept(calls.get(context.id), (value) => {
          assert.equal(value, output);
          assert.equal(invocation.children.get(calls.get(context.id)).reception.status, 'receiving');
          accepted.push(context.currentInput);
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
      async execute(_context, invocation, children) {
        const entry = children.get(operation);
        const first = entry.create(invocation, 'first');
        const second = entry.create(invocation, 'second');
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
          const firstOutput = await children.accept(first, (value) => value);
          const secondOutput = await children.accept(second, (value) => value);
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
      accept(context, output, invocation, children) {
        assert.notEqual(invocation, previous.invocation);
        assert.notEqual(children, previous.children);
        assert.deepEqual(Object.keys(context.resources.values), ['normal']);
        assert.deepEqual(realized, ['continuation']);
        assert.equal(context.resources.values.normal, 'normal access');
        assert.equal(invocation.checkpoint, undefined);
        assert.equal(invocation.output, undefined);
        return children.accept(call, (value) => {
          assert.equal(value, output);
          return value.answer;
        });
      },
    },
    checkpoint: {
      key: 'test.invocationAccess.resume',
      version: 1,
      input: codec,
      output: codec,
      points: {
        saved: {
          state: codec,
          resume: {
            requires: { continuation: continuation.request() },
            uses: [child],
            execute(context, invocation, children) {
              assert.deepEqual(realized, []);
              assert.deepEqual(Object.keys(context.resources.values), ['continuation']);
              assert.equal(context.resources.values.continuation, 'continuation access');
              assert.ok(invocation.checkpoint);
              previous = { invocation, children };
              call = children.get(child).create(invocation, null);
              return call.run();
            },
          },
        },
      },
    },
  };
  const store = new MemoryCheckpointStore();
  store.save({ id: 'saved-access', formatVersion: 1, contract: { key: definition.checkpoint.key, version: 1 }, point: 'saved', frame: { owner: { contextId: 'restored-access', level: 'runtime' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] }, state: null }, 0);
  const runtime = assemble(definition, { checkpoints: { store }, providers: [normal.provide(() => null), continuation.provide(() => null)], source: { runtime: () => null, entry: () => null, capture: () => null } });
  assert.deepEqual(realized, []);
  assert.equal(await runtime.resume('restored-access', {}), 'child output');
  assert.deepEqual(realized, ['continuation', 'normal']);
  assert.equal(store.read('restored-access').delivery.output, 'child output');
});
