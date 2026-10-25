import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { Resources, Runner, Scene, Node, ChangeCaptureError } from '@capix/server-runtime';
import { Resource, ResourceOffer } from '@capix/resources';

test('parent failure reception cannot turn a child necessary capture fault into a handled business outcome', async () => {
  const failure = new ChangeCaptureError({ kind: 'already-committed' }, new Error('capture failed'));
  const offer = new ResourceOffer({
    methods: {
      write() {
        throw failure;
      },
    },
  });
  const node = new Node({ deps: { store: offer.request() }, run: (work) => work.resources.store.write(null) });
  let handled = 0;
  const scene = new Scene({
    run: (work) =>
      work.children.invoke(node, null, {
        result: {
          failed() {
            handled++;
            return 'incorrect fallback';
          },
        },
      }),
  }).add(node);
  const runner = new Runner(scene, new Resources().register(new Resource({}), offer)).build();
  await assert.rejects(runner.run(null), (error) => error === failure);
  assert.equal(handled, 0);
});

test('invoke isolates an async delta consumer while its explicit output observer stays connected', () => {
  const script = `
    import { Runner, Scene, Node, Resources } from '@capix/server-runtime';
    const unhandled = []; process.on('unhandledRejection', error => unhandled.push(String(error)));
    let deltas = 0; const events = [];
    const node = new Node({ output: { result: value => value, delta: value => value }, async run(work) { work.output.emit('a'); await Promise.resolve(); work.output.emit('b'); return 'ab'; } });
    const scene = new Scene({ run: work => work.children.invoke(node, null, { delta: async () => { deltas++; throw new Error('passive consumer'); }, output: { receive(event) { events.push(event.kind); } } }) }).add(node);
    const value = await new Runner(scene, new Resources()).build().run(null);
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({ value, deltas, events, unhandled }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  assert.equal(result.value, 'ab');
  assert.equal(result.deltas, 1);
  assert.deepEqual(result.unhandled, []);
  assert.equal(result.events.filter((kind) => kind === 'delta').length, 2);
  assert.equal(result.events.at(-1), 'completed');
});

test('a child output contract fault remains outside parent failure reception', async () => {
  let handled = 0;
  const node = new Node({
    output: {
      result() {
        throw new Error('invalid output');
      },
    },
    run: () => 'value',
  });
  const scene = new Scene({
    run: (work) =>
      work.children.invoke(node, null, {
        result: {
          failed() {
            handled++;
            return 'incorrect fallback';
          },
        },
      }),
  }).add(node);
  await assert.rejects(new Runner(scene, new Resources()).build().run(null), (error) => error.code === 'OUTPUT_CONTRACT');
  assert.equal(handled, 0);
});

test('child aggregate failure eligibility terminates on cycles and still detects nested protected faults', async () => {
  const cyclic = new AggregateError([], 'cyclic');
  cyclic.errors.push(cyclic);
  const invoke = async (failure, failed) => {
    const node = new Node({
      run() {
        throw failure;
      },
    });
    const scene = new Scene({ run: (work) => work.children.invoke(node, null, { result: { failed } }) }).add(node);
    return new Runner(scene, new Resources()).build().run(null);
  };
  assert.equal(
    await invoke(cyclic, (error) => {
      assert.equal(error, cyclic);
      return 'handled';
    }),
    'handled',
  );
  cyclic.errors.push(new ChangeCaptureError({ kind: 'committed' }, new Error('capture')));
  let handled = 0;
  await assert.rejects(
    invoke(cyclic, () => {
      handled++;
      return 'wrong';
    }),
    (error) => error === cyclic,
  );
  assert.equal(handled, 0);
});

test('child failure classification never evaluates an aggregate errors accessor', async () => {
  const failure = new AggregateError([], 'opaque');
  let reads = 0;
  let handled = 0;
  Object.defineProperty(failure, 'errors', {
    get() {
      reads++;
      throw new Error('errors getter must not execute');
    },
  });
  const node = new Node({
    run() {
      throw failure;
    },
  });
  const scene = new Scene({
    run: (work) =>
      work.children.invoke(node, null, {
        result: {
          failed() {
            handled++;
            return 'wrong';
          },
        },
      }),
  }).add(node);
  await assert.rejects(new Runner(scene, new Resources()).build().run(null), (error) => error === failure);
  assert.equal(reads, 0);
  assert.equal(handled, 0);
});
