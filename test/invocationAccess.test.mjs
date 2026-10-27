import { installCallable } from './fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, Node, checkpointPoint } from '@capix/server-runtime';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { ResourceOffer } from '@capix/resources';
import { runtimeDefinition } from './fixtures/declarations.mjs';

function assemble(definition, options = {}) {
  return installCallable(definition, { providers: [], source: { entry: () => null, capture: () => null }, ...options });
}

test('ordinary Work has one business entry and does not expose runtime control objects', async () => {
  const output = {};
  const processes = [];
  const scene = new Scene({
    run(work) {
      for (const key of ['access', 'invocation', 'context', 'complete', 'round', 'continue', 'continuation']) assert.equal(key in work, false);
      return output;
    },
  });
  const installed = assemble(scene, {
    observations: [
      {
        bindInvocation: () => ({
          observe: (fact) => {
            if (fact.kind === 'process') processes.push(fact.process);
          },
        }),
      },
    ],
  });
  assert.equal(await installed.run(null, {}), output);
  assert.deepEqual(
    processes.map((process) => [process.stage, process.type]),
    [
      ['execute', 'start'],
      ['execute', 'return'],
    ],
  );
});

test('concurrent child operations have independent resource endpoints and local receptions', async () => {
  const pending = new Map();
  const scopes = new Map();
  const accepted = [];
  let exposed = 0;
  const offer = new ResourceOffer({
    expose(_source, activity) {
      exposed++;
      const token = {};
      return { token, touch: () => activity.runSync('touch', {}, () => token) };
    },
  });
  const leaf = new Node({ run: (work) => new Promise((resolve) => pending.set(work.input, resolve)) });
  const group = new Group({
    deps: { owner: offer.request() },
    async run(work) {
      const owner = work.resources.owner;
      scopes.set(work.input, owner);
      return work.children.invoke(leaf, work.input, {
        result: {
          succeeded(value) {
            assert.equal(owner.touch(), owner.token);
            assert.equal(work.resources.owner, owner);
            accepted.push(work.input);
            return value;
          },
        },
      });
    },
  }).add(leaf);
  const scene = new Scene({
    async run(work) {
      const first = work.children.invoke(group, 'first');
      const second = work.children.invoke(group, 'second');
      try {
        assert.equal(exposed, 2);
        assert.notEqual(scopes.get('first'), scopes.get('second'));
        pending.get('second')('second result');
        assert.equal(await second, 'second result');
        pending.get('first')('first result');
        return [await first, await second];
      } finally {
        for (const resolve of pending.values()) resolve('cleanup');
        await Promise.allSettled([first, second]);
      }
    },
  }).add(group);
  assert.deepEqual(await assemble(scene, { providers: [offer.provide(() => null)] }).run(null, {}), ['first result', 'second result']);
  assert.deepEqual(accepted, ['second', 'first']);
});

test('recovery has its own declared resource window and never reopens normal run', async () => {
  const realized = [];
  const normal = new ResourceOffer({
    expose() {
      realized.push('normal');
      return 'normal';
    },
  });
  const restored = new ResourceOffer({
    expose() {
      realized.push('restored');
      return 'restored';
    },
  });
  const child = new Node({ run: () => 'child result' });
  const codec = { encode: (value) => value, decode: (value) => value };
  const point = checkpointPoint()({
    name: 'saved',
    state: codec,
    references: {},
    resume: {
      deps: { data: restored.request() },
      uses: [child],
      async run(work) {
        assert.deepEqual(Object.keys(work.resources), ['data']);
        assert.equal(work.resources.data, 'restored');
        return work.children.invoke(child, null, { result: { succeeded: (value) => value + ':received' } });
      },
    },
  });
  const scene = new Scene({ deps: { normal: normal.request() }, run: () => assert.fail('must not replay'), checkpoint: { key: 'access.recovery', version: 2, input: codec, output: codec, points: [point] } }).add(child);
  const store = new MemoryCheckpointStore();
  store.save({ id: 'image', formatVersion: 5, contract: { key: scene.checkpoint.key, version: 2 }, point: 'saved', frame: { owner: { contextId: 'restored', kind: 'scene' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] }, state: null, references: {} }, 0);
  assert.equal(await assemble(scene, { checkpoints: { store }, providers: [normal.provide(() => null), restored.provide(() => null)] }).resume('restored', {}), 'child result:received');
  assert.deepEqual(realized, ['restored']);
});

test('retained restored resource and checkpoint endpoints close permanently at return', async () => {
  const offer = new ResourceOffer({ expose: (_source, activity) => ({ read: () => activity.runSync('read', {}, () => 7) }) });
  const codec = { encode: (value) => value, decode: (value) => value };
  let retained;
  const point = checkpointPoint()({
    name: 'saved',
    state: codec,
    references: {},
    resume: {
      deps: { data: offer.request() },
      run(work) {
        retained = { work, endpoint: work.resources.data };
        return retained.endpoint.read();
      },
    },
  });
  const scene = new Scene({ run: () => assert.fail('must not replay'), checkpoint: { key: 'access.closed', version: 2, input: codec, output: codec, points: [point] } });
  const store = new MemoryCheckpointStore();
  store.save({ id: 'image', formatVersion: 5, contract: { key: scene.checkpoint.key, version: 2 }, point: 'saved', frame: { owner: { contextId: 'restored', kind: 'scene' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] }, state: null, references: {} }, 0);
  assert.equal(await assemble(scene, { checkpoints: { store }, providers: [offer.provide(() => null)] }).resume('restored', {}), 7);
  assert.throws(() => retained.work.resources.data, /closed|ended/);
  assert.throws(() => retained.endpoint.read(), /closed|ended/);
  assert.throws(() => retained.work.checkpoint({ point, state: null }), /closed|ended/);
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
      const child = new Group({ deps: {}, run: () => 'child result' });
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
        output: { result: (value) => value, delta: (value) => value },
        deps: { data: resource.request() },
        run: execute,

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
      assert.equal(receptionFinished, true);
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
