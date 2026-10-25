import { installCallable } from './fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, Node, ResourceOffer, MemoryCheckpointStore, checkpointPoint } from '@capix/server-runtime';
import { runtimeDefinition } from './fixtures/declarations.mjs';

function assemble(definition, options = {}) {
  return installCallable(definition, { providers: [], source: { entry: () => null, capture: () => null }, ...options });
}

test('assembled work preserves absent acceptance as a reuse fact instead of inserting an identity receiver', async () => {
  for (const explicit of [false, true]) {
    const output = { answer: 'original object' };
    const processes = [];
    let accepted = 0;
    const run = {
      deps: {},
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
    const definition = new Scene({ deps: run.deps, run: run.execute.bind(run), accept: run.accept?.bind(run) });
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
  const resource = new ResourceOffer({
    name: 'test.invocationAccess.owner',
    expose: (_value, activity) => {
      exposed++;
      const token = {};
      return { token, touch: () => activity.runSync('touch', {}, () => token) };
    },
  });
  const deps = { owner: resource.request() };
  const leaf = new Node({
    name: 'await-result',
    label: 'Await result',
    source: 'test',
    callee: 'test',
    maxRounds: 1,
    raises: [],
    deps: {},
    run: (work) => new Promise((resolve) => pending.set(work.input, resolve)),
  });
  const operation = new Group({
    name: 'overlap',
    label: 'Overlap',
    source: 'test',
    maxRounds: 1,
    raises: [],
    deps,
    async run(work) {
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
  }).add(leaf);
  const execution = new Group({
    maxRounds: 1,
    raises: [],
    deps,
    async run(work) {
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
  }).add(operation);
  const runtime = assemble(runtimeDefinition(execution), { providers: [resource.provide(() => null)] });
  assert.equal(exposed, 0);
  assert.deepEqual(await runtime.run(null, {}), ['first result', 'second result']);
  assert.deepEqual(accepted, ['second', 'first']);
  assert.equal(exposed, 2);
});

test('checkpoint continuation hands its child delivery to normal acceptance with the correct phase resource view', async () => {
  const realized = [];
  const normal = new ResourceOffer({
    name: 'test.invocationAccess.normal',
    expose: () => {
      realized.push('normal');
      return 'normal access';
    },
  });
  const continuation = new ResourceOffer({
    name: 'test.invocationAccess.continuation',
    expose: () => {
      realized.push('continuation');
      return 'continuation access';
    },
  });
  const child = new Group({ maxRounds: 1, raises: [], deps: {}, run: () => ({ answer: 'child output' }) });
  const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
  let call;
  let previous;
  const definition = new Scene({
    maxRounds: 1,
    raises: [],
    deps: { normal: normal.request() },
    uses: [],
    run: () => assert.fail('normal execute must not replay'),
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
            deps: { continuation: continuation.request() },
            uses: [child],
            run(work) {
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
  }).add(child);
  const store = new MemoryCheckpointStore();
  store.save({ id: 'saved-access', formatVersion: 5, contract: { key: definition.checkpoint.key, version: 1 }, point: 'saved', frame: { owner: { contextId: 'restored-access', kind: 'scene' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] }, state: null, references: {} }, 0);
  const runtime = assemble(definition, { checkpoints: { store }, providers: [normal.provide(() => null), continuation.provide(() => null)], source: { runtime: () => null, entry: () => null, capture: () => null } });
  assert.deepEqual(realized, []);
  assert.equal(await runtime.resume('restored-access', {}), 'child output');
  assert.deepEqual(realized, ['continuation', 'normal']);
  assert.equal(store.read('restored-access').delivery.output, 'child output');
});

test('a restored point closes retained resource views, endpoints and checkpoint actions before normal acceptance', async (t) => {
  for (const retained of ['view', 'endpoint', 'checkpoint']) {
    await t.test(retained, async () => {
      const offer = new ResourceOffer({ name: `test.resume-window.${retained}`, expose: (_source, activity) => ({ read: () => activity.runSync('read', {}, () => 'fixed value') }) });
      const codec = { encode: (value) => value, decode: (value) => value };
      let oldWork;
      let oldEndpoint;
      let fixed;
      const point = checkpointPoint()({
        name: 'saved',
        state: codec,
        references: {},
        resume: {
          deps: { data: offer.request() },
          run(work) {
            oldWork = work;
            oldEndpoint = work.resources.data;
            fixed = oldEndpoint.read();
            return fixed;
          },
        },
      });
      const definition = new Scene({
        maxRounds: 1,
        raises: [],
        deps: { data: offer.request() },
        run: () => assert.fail('normal execute must not replay'),
        accept(work) {
          assert.equal(fixed, 'fixed value');
          assert.notEqual(work.resources.data, oldEndpoint);
          assert.equal(work.resources.data.read(), fixed);
          const attempt = retained === 'view' ? () => oldWork.resources.data : retained === 'endpoint' ? () => oldEndpoint.read() : () => oldWork.checkpoint({ point: point, state: null, refs: {} });
          assert.throws(attempt, /window is closed/);
          return work.delivered;
        },
        checkpoint: { key: `resume-window.${retained}`, version: 1, input: codec, output: codec, points: [point] },
      });
      const store = new MemoryCheckpointStore();
      store.save({ id: `image-${retained}`, formatVersion: 5, contract: { key: definition.checkpoint.key, version: 1 }, point: 'saved', frame: { owner: { contextId: `call-${retained}`, kind: 'scene' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] }, state: null, references: {} }, 0);
      const runtime = assemble(definition, { checkpoints: { store }, providers: [offer.provide(() => null)], source: { runtime: () => null, capture: () => null } });
      // Catching an illegal port use cannot erase the already-owned kernel fault.
      await assert.rejects(runtime.resume(`call-${retained}`, {}), /window is closed/);
    });
  }
});

test('execute and restored point bodies seal output while entered reception retains its phase resources', async (t) => {
  for (const mode of ['normal', 'restored']) {
    await t.test(mode, { timeout: 3000 }, async () => {
      const gate = Promise.withResolvers();
      const bodyReturned = Promise.withResolvers();
      const events = [];
      const reads = [];
      const final = { answer: 'final' };
      const codec = { encode: (value) => value, decode: (value) => value };
      const resource = new ResourceOffer({
        name: `test.output-reception-window.${mode}`,
        expose: (_source, activity) => ({
          read: () => activity.runSync('read', {}, () => 'phase resource'),
        }),
      });
      const child = new Group({ maxRounds: 1, raises: [], deps: {}, run: () => 'child result' });
      let reception;
      let receptionFinished = false;
      let settled = false;
      async function execute(work) {
        const endpoint = work.resources.data;
        work.output.emit('body');
        const call = work.children.create(child, null);
        await call.run();
        reception = call.accept(async (value) => {
          await gate.promise;
          reads.push(endpoint.read(), work.resources.data.read());
          assert.throws(() => work.output.emit('late preview'), { code: 'OUTPUT_CLOSED' });
          receptionFinished = true;
          return value;
        });
        bodyReturned.resolve();
        return final;
      }
      const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { deps: { data: resource.request() }, uses: [child], run: execute } });
      const definition = new Scene({
        maxRounds: 1,
        raises: [],
        output: { result: (value) => value, delta: (value) => value },
        deps: { data: resource.request() },
        uses: [child],
        run: execute,
        accept(work) {
          assert.equal(receptionFinished, true);
          return work.delivered;
        },
        checkpoint: { key: `output-reception-window.${mode}`, version: 1, input: codec, output: codec, points: [point] },
      }).add(child);
      const store = new MemoryCheckpointStore();
      if (mode === 'restored') store.save({ id: 'output-window-image', formatVersion: 5, contract: { key: definition.checkpoint.key, version: 1 }, point: 'saved', frame: { owner: { contextId: 'output-window-call', kind: 'scene' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] }, state: null, references: {} }, 0);
      const runtime = assemble(definition, {
        checkpoints: { store },
        providers: [resource.provide(() => null)],
        source: {
          runtime: () => null,
          capture: () => null,
          output: () => ({
            receive(event) {
              events.push(event);
            },
          }),
        },
      });
      const completion = mode === 'restored' ? runtime.resume('output-window-call', {}) : runtime.run(null, {});
      void completion.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await bodyReturned.promise;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        assert.equal(receptionFinished, false);
        assert.deepEqual(
          events.map((event) => event.kind),
          ['started', 'delta', 'sealed'],
        );
      } finally {
        gate.resolve();
      }
      assert.equal(await completion, final);
      assert.equal(await reception, 'child result');
      assert.deepEqual(reads, ['phase resource', 'phase resource']);
      assert.deepEqual(
        events.map((event) => event.kind),
        ['started', 'delta', 'sealed', 'completed'],
      );
      assert.equal(events.at(-1).result, final);
    });
  }
});
