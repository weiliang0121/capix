import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, withDependencies } from '@weiliang0121/capix-structure';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';

test('a common flow request shares material within each Group invocation and keeps concurrent invocations isolated', async () => {
  const flow = new ResourceOffer({
    methods: {
      append(origin, value) {
        origin.values.push(value);
      },
      read(origin) {
        return { id: origin.id, values: [...origin.values] };
      },
    },
  });
  const common = withDependencies({ flow: flow.request() });
  const endpoints = [];
  const states = [];
  let arrivals = 0;
  const bothStarted = Promise.withResolvers();
  const node = common.node()({
    async run(work) {
      endpoints.push(work.resources.flow);
      await work.resources.flow.append(work.input);
      if (work.input === 'first' && ++arrivals === 2) bothStarted.resolve();
      if (work.input === 'first') await bothStarted.promise;
      return work.resources.flow.read();
    },
  });
  const group = common.group()({
    members: [node],
    async run(work) {
      endpoints.push(work.resources.flow);
      await work.resources.flow.append(`group:${work.input}`);
      const first = await work.children.create(node, 'first').invoke();
      const second = await work.children.create(node, 'second').invoke();
      const final = await work.resources.flow.read();
      assert.equal(first.id, second.id);
      assert.equal(second.id, final.id);
      return final;
    },
  });
  const scene = new Scene().add({ group });
  scene.run = (work) => Promise.all(work.input.map((input) => work.children.group.invoke(input)));
  const resources = new Resources();
  resources
    .capture(group, () => {
      const state = { id: states.length + 1, values: [] };
      states.push(state);
      return state;
    })
    .register(flow, (state) => state);
  const runner = new Runner(scene, resources).build();
  assert.equal(states.length, 0, 'building only fixes the capture connection');
  assert.deepEqual(await runner.run(['A', 'B']), [
    { id: 1, values: ['group:A', 'first', 'second'] },
    { id: 2, values: ['group:B', 'first', 'second'] },
  ]);
  assert.deepEqual(await runner.run(['C', 'D']), [
    { id: 3, values: ['group:C', 'first', 'second'] },
    { id: 4, values: ['group:D', 'first', 'second'] },
  ]);
  assert.equal(new Set(states).size, 4);
  assert.equal(new Set(endpoints).size, 12, 'every Group/Node invocation gets its own endpoint window');
  for (const endpoint of endpoints) await assert.rejects(endpoint.read(), /closed|ended|running|active/);
  assert.deepEqual(
    states.map((state) => state.values[0]),
    ['group:A', 'group:B', 'group:C', 'group:D'],
  );
});

test('a nested capture shadows only its registered offer and leaves the outer flow and other inherited resources intact', async () => {
  const flow = new ResourceOffer({
    methods: {
      append(origin, value) {
        origin.push(value);
      },
      read(origin) {
        return [...origin];
      },
    },
  });
  const label = new ResourceOffer({ methods: { read: (origin) => origin } });
  const common = withDependencies({ flow: flow.request(), label: label.request() });
  const makeLeaf = () =>
    common.node()({
      async run(work) {
        await work.resources.flow.append(work.input);
        return { values: await work.resources.flow.read(), label: await work.resources.label.read() };
      },
    });
  const innerLeaf = makeLeaf();
  const sibling = makeLeaf();
  const inner = common.group()({ members: [innerLeaf], run: (work) => work.children.create(innerLeaf, 'inner-leaf').invoke() });
  const outer = common.group()({
    members: [inner, sibling],
    async run(work) {
      await work.resources.flow.append('outer-group');
      const nested = await work.children.create(inner, null).invoke();
      const inherited = await work.children.create(sibling, 'sibling').invoke();
      return { nested, inherited, own: await work.resources.flow.read() };
    },
  });
  const scene = new Scene().add({ outer });
  scene.run = (work) => work.children.outer.invoke(null);
  const resources = new Resources();
  resources.register(label, 'shared-label');
  resources.capture(outer, () => ['outer']).register(flow, (state) => state);
  resources.capture(inner, () => ['inner']).register(flow, (state) => state);
  assert.deepEqual(await new Runner(scene, resources).build().run(null), {
    nested: { values: ['inner', 'inner-leaf'], label: 'shared-label' },
    inherited: { values: ['outer', 'outer-group', 'sibling'], label: 'shared-label' },
    own: ['outer', 'outer-group', 'sibling'],
  });
});

test('failure closes flow endpoints without rolling back material or replaying work on the next invocation', async () => {
  const flow = new ResourceOffer({
    methods: {
      increment(origin) {
        origin.count++;
        return origin.count;
      },
      read(origin) {
        return origin.count;
      },
    },
  });
  const common = withDependencies({ flow: flow.request() });
  const origins = [];
  const endpoints = [];
  let executions = 0;
  const child = common.node()({
    async run(work) {
      executions++;
      endpoints.push(work.resources.flow);
      const result = await work.resources.flow.increment();
      if (work.input) throw new Error('after write');
      return result;
    },
  });
  const group = common.group()({ members: [child], run: (work) => work.children.create(child, work.input).invoke() });
  const scene = new Scene().add({ group });
  scene.run = (work) => work.children.group.invoke(work.input);
  const resources = new Resources();
  resources
    .capture(group, () => {
      const state = { count: 0 };
      origins.push(state);
      return state;
    })
    .register(flow, (state) => state);
  const runner = new Runner(scene, resources).build();
  await assert.rejects(runner.run(true), /after write/);
  assert.equal(origins[0].count, 1, 'ordinary flow material has no automatic rollback');
  await assert.rejects(endpoints[0].read(), /closed|ended|running|active/);
  assert.equal(await runner.run(false), 1);
  assert.equal(executions, 2, 'the next run does not replay the failed invocation');
  assert.equal(origins.length, 2);
  assert.notEqual(origins[0], origins[1]);
  await assert.rejects(endpoints[1].read(), /closed|ended|running|active/);
});

test('shared dependencies require explicit supply and do not create another capture scope', async () => {
  const flow = new ResourceOffer({ methods: { read: (origin) => origin } });
  const common = withDependencies({ flow: flow.request() });
  const scene = common.scene()({ run: (work) => work.resources.flow.read() });
  const resources = new Resources();
  const runner = new Runner(scene, resources);
  assert.throws(() => runner.build(), /missing|supply|provider/i);
  resources.capture(scene, () => ({ flow: 'captured', other: 1 })).register(flow, (state) => state.flow);
  assert.throws(() => resources.capture(scene, () => 'second scope'), /Duplicate resource capture scope/);
  assert.equal(await runner.build().run(null), 'captured');
});
