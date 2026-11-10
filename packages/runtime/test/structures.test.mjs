import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Node } from '@weiliang0121/capix-structure';
import { Driver } from '@weiliang0121/capix-runtime';
import { Scene, Group } from '@weiliang0121/capix-structure';
import { callableConstruction } from '@weiliang0121/capix-runtime/construction';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import { checkpointPoint } from '@weiliang0121/capix-structure';
import { Resources } from '@weiliang0121/capix-runtime';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { CallableBuilder, createRootInvocation } from '@weiliang0121/capix-runtime/construction';

const build = (driver, structure, providers = []) => driver.build(structure, { providers, source: { capture: () => null } });

const codec = { encode: (value) => value, decode: (value) => value };

test('constructors and field assignments configure the same callable objects without executing business work', async () => {
  let calls = 0;
  const result = { answer: 42 };
  const definition = {
    run: () => {
      calls++;
      return result;
    },
  };
  const direct = new Node(definition);
  const configured = new Node();
  Object.assign(configured, definition);
  assert.notEqual(direct, configured);
  assert.equal(calls, 0);
  const driver = new Driver();
  assert.deepEqual(await driver.run(build(driver, direct), null, {}), result);
  assert.deepEqual(await driver.run(build(driver, configured), null, {}), result);
  assert.equal(calls, 2);
});

test('local structures compose with add while each composite explicitly runs and accepts its children', async () => {
  const events = [];
  const leaf = new Node({
    run: (work) => {
      events.push('node');
      return work.input + 1;
    },
  });
  const unused = new Node({ run: () => assert.fail('add must not schedule members') });
  const group = new Group();
  group.add(leaf, unused);
  Object.assign(group, {
    deps: undefined,
    run: async function (work) {
      events.push('group');
      const child = work.children.create(leaf, work.input);
      await child.run();
      return child.accept((value) => value * 2);
    },
  });
  const scene = new Scene();
  scene.add(group);
  Object.assign(scene, {
    deps: undefined,
    run: async function (work) {
      events.push('scene');
      const child = work.children.create(group, work.input);
      await child.run();
      return child.accept((value) => value + 3);
    },
  });
  assert.deepEqual(events, []);
  const driver = new Driver();
  assert.equal(await driver.run(build(driver, scene), 4, {}), 13);
  assert.deepEqual(events, ['scene', 'group', 'node']);
});

test('the same business configuration produces independent child identities and persistent positions', async () => {
  const config = { run: (work) => work.input };
  const left = new Node(config);
  const right = new Node(config);
  const group = new Group();
  group.add(left, right, left);
  assert.deepEqual(group.members, [left, right]);
  Object.assign(group, {
    deps: undefined,
    run: async function (work) {
      const a = work.children.create(left, 'left');
      const b = work.children.create(right, 'right');
      await Promise.all([a.run(), b.run()]);
      const first = await a.accept();
      const second = await b.accept();
      assert.equal(work.children.facts.list(left).length, 1);
      assert.equal(work.children.facts.list(right).length, 1);
      return [first, second];
    },
  });
  const driver = new Driver();
  const bound = build(driver, group);
  assert.equal(bound, group);
  assert.equal(callableConstruction(bound).binding.children.position(left), 0);
  assert.equal(callableConstruction(bound).binding.children.position(right), 1);
  assert.deepEqual(await driver.run(bound, null, {}), ['left', 'right']);
});

test('same-signature objects remain distinct when validating a child reference', async () => {
  const left = new Node({ run: () => 'left' });
  const right = new Node({ run: () => 'right' });
  const group = new Group();
  group.add(left, right);
  Object.assign(group, {
    deps: undefined,
    run: async function (work) {
      const child = work.children.create(right, null);
      await child.run();
      return work.children.facts.require(left, child.ref);
    },
  });
  const driver = new Driver();
  await assert.rejects(driver.run(build(driver, group), null, {}), /different declaration/);
});

test('successful build locks the whole structure while retaining its original identity', async () => {
  const first = new Node({ run: (work) => `first:${work.input}` });
  const second = new Node({ run: (work) => `second:${work.input}` });
  const group = new Group();
  group.add(first);
  Object.assign(group, {
    deps: undefined,
    run: async function (work) {
      const child = work.children.create(first, work.input);
      await child.run();
      return child.accept();
    },
  });
  const driver = new Driver();
  const installed = build(driver, group);
  assert.equal(installed, group);
  assert.throws(() => group.add(second), /locked|built|build|read only/i);
  assert.throws(() => group.add(first), /locked|built|build|read only/i);
  assert.throws(() => Object.assign(group, { deps: {}, run: () => 'replacement' }), /locked|built|build|read only/i);
  assert.throws(() => Object.assign(group, { run: () => 'replacement' }), /locked|built|build|read only/i);
  assert.throws(() => Object.assign(first, { deps: {}, run: () => 'changed later' }), /locked|built|build|read only/i);
  assert.throws(() => {
    group.members = [second];
  }, TypeError);
  assert.throws(() => {
    first.run = () => 'replacement';
  }, TypeError);
  assert.throws(() => {
    first.name = 'replacement';
  }, TypeError);
  assert.equal(await driver.run(installed, 1, {}), 'first:1');
  assert.equal(callableConstruction(installed).binding.children.definitions().length, 1);
  assert.throws(() => build(driver, group), /built|build|install|locked/i);
  assert.throws(() => build(new Driver(), group), /built|build|install|locked/i);
  const another = new Group({ run: () => null });
  assert.doesNotThrow(() => another.add(second));
});

test('build reads the final resource configuration', async () => {
  const oldOffer = new ResourceOffer({ name: 'structures.old', expose: (value) => value });
  const newOffer = new ResourceOffer({ name: 'structures.new', expose: (value) => value });
  const node = new Node();
  Object.assign(node, { deps: { old: oldOffer.request() }, run: (work) => work.resources.old });
  Object.assign(node, { deps: { next: newOffer.request() }, run: (work) => work.resources.next });
  const driver = new Driver();
  assert.throws(() => build(driver, node, [oldOffer.provide(() => 'old')]), /resource provider/);
  const ready = build(driver, node, [newOffer.provide(() => 'new')]);
  assert.equal(await driver.run(ready, null, {}), 'new');
});

test('assigning one configuration field leaves unrelated contracts and membership intact', async () => {
  const child = new Node({ run: () => null });
  const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { run: () => null } });
  const checkpoint = { key: 'structures.local', version: 1, input: codec, output: codec, points: [point] };
  const output = { result: (value) => value, delta: (value) => value };
  const group = new Group({ name: 'named', checkpoint, output, run: () => 'before' }).add(child);
  group.run = () => 'after';
  assert.deepEqual(group.members, [child]);
  assert.equal(group.name, 'named');
  assert.equal(group.checkpoint, checkpoint);
  assert.equal(group.output, output);
  const driver = new Driver();
  assert.equal(await driver.run(build(driver, group), null, {}), 'after');
});

test('constructor and assignment preserve business receivers without freezing the host object', async () => {
  const handler = {
    count: 0,
    execute(work) {
      this.count++;
      return this.count + work.input;
    },
  };
  const constructor = new Node({ run: handler.execute.bind(handler) });
  const setter = new Node();
  Object.assign(setter, { deps: {}, run: handler.execute.bind(handler) });
  const driver = new Driver();
  const a = build(driver, constructor);
  const b = build(driver, setter);
  handler.count = 10;
  handler.execute = () => assert.fail('bound work must retain the previous entry');
  assert.equal(await driver.run(a, 1, {}), 12);
  assert.equal(await driver.run(b, 1, {}), 13);
  assert.equal(Object.isFrozen(handler), false);
});

test('build rejects incomplete or obsolete configuration before execution', () => {
  const driver = new Driver();
  const node = new Node();
  assert.throws(() => build(driver, node), /run function/);
  node.run = () => 'configured';
  node.uses = [];
  assert.throws(() => build(driver, node), /Unsupported callable configuration field: uses/);
  delete node.uses;
  assert.doesNotThrow(() => build(driver, node));
});

test('an assigned processing function is the only entry fixed by build', async () => {
  class Custom extends Node {
    deps = {};
    run = () => 'original';
  }
  const node = new Custom();
  const driver = new Driver();
  Object.assign(node, { deps: {}, run: () => 'replacement' });
  const installed = build(driver, node);
  assert.equal(installed, node);
  assert.equal(await driver.run(installed, null, {}), 'replacement');
  assert.throws(() => Object.assign(node, { deps: {}, run: () => 'too late' }), /locked|built|build|read only/i);
});

test('build validates ordinary assignments without publishing partial runtime state', async () => {
  const node = new Node({ name: 'original', run: () => 'original' });
  node.run = null;
  const driver = new Driver();
  assert.throws(() => build(driver, node), /run function/);
  assert.throws(() => callableConstruction(node), /not been built/);
  assert.throws(() => {
    node.kind = 'group';
  }, TypeError);
  node.run = () => 'repaired';
  assert.equal(node.name, 'original');
  assert.equal(await driver.run(build(driver, node), null, {}), 'repaired');
});

test('a prototype clone cannot inherit the configuration identity of another structure', () => {
  const original = new Node({ run: () => null });
  const forged = Object.create(original);
  const group = new Group({ run: () => null });
  assert.throws(() => group.add(forged), /initialized|configuration/i);
  assert.deepEqual(group.members, []);
  assert.throws(() => build(new Driver(), forged), /initialized|configuration/i);
  assert.doesNotThrow(() => group.add(original));
});

test('a rejected proxy does not claim membership or reserve the real structure for construction', async () => {
  const original = new Node({ run: () => 'original' });
  const proxy = new Proxy(original, {});
  const first = new Node({ run: () => 'first' });
  const group = new Group({ run: () => null });
  assert.throws(() => group.add(first, proxy), /proxies/i);
  assert.deepEqual(group.members, []);
  const other = new Group({ run: () => null });
  assert.doesNotThrow(() => other.add(first));
  const driver = new Driver();
  assert.throws(() => build(driver, proxy), /proxies/i);
  assert.throws(() => callableConstruction(original), /not been built/);
  assert.equal(await driver.run(build(driver, original), null, {}), 'original');
});

test('a nonconfigurable members accessor cannot leave a partly installed structure tree', () => {
  const child = new Node({ run: () => null });
  const group = new Group({ run: () => null }).add(child);
  Object.defineProperty(group, 'members', { get: () => [child], configurable: false });
  assert.throws(() => build(new Driver(), group), /members.*fixed|fixed.*members/i);
  assert.throws(() => callableConstruction(group), /not been built/);
  assert.throws(() => callableConstruction(child), /not been built/);
  assert.doesNotThrow(() => Object.assign(child, { deps: {}, run: () => 'still configurable' }));
});

test('a low-level Builder fixes selected mechanisms without freezing provider state', async () => {
  const store = new MemoryCheckpointStore();
  const other = new MemoryCheckpointStore();
  const observed = {
    facts: [],
    observe(fact) {
      this.facts.push(fact);
    },
  };
  let invocationBindings = 0;
  const observations = [
    {
      bindInvocation: () => {
        invocationBindings++;
        return { observe() {} };
      },
    },
  ];
  const checkpoints = { store, observation: observed };
  const capabilities = { checkpoints, observations };
  const builder = new CallableBuilder(capabilities);
  const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { run: (_work, state) => state } });
  const node = new Node({
    checkpoint: { key: 'structures.mechanisms', version: 1, input: codec, output: codec, points: [point] },
    run(work) {
      work.checkpoint({ point: point, state: 'result', refs: {} });
      return 'result';
    },
  });
  const ready = builder.build(node, new Resources());
  checkpoints.store = other;
  checkpoints.observation = { observe: () => assert.fail('replacement checkpoint observer must not install') };
  observed.observe = () => assert.fail('replacement checkpoint method must not install');
  observations.length = 0;
  capabilities.observations = [{ bindInvocation: () => assert.fail('replacement invocation observer must not install') }];
  capabilities.checkpoints = { store: other };
  assert.equal(await createRootInvocation(ready, null, {}).run(), 'result');
  const saved = observed.facts.find((fact) => fact.kind === 'saved');
  assert.ok(saved);
  assert.equal(store.read(saved.contextId).delivery.status, 'succeeded');
  assert.equal(other.read(saved.contextId), undefined);
  assert.equal(invocationBindings, 1);
  assert.equal(Object.isFrozen(store), false);
  assert.equal(Object.isFrozen(observed), false);
});

test('an already built root cannot be adopted by an unbuilt parent', () => {
  const node = new Node({ run: () => null });
  build(new Driver(), node);
  const group = new Group({ run: () => null });
  assert.throws(() => group.add(node), /built|build|parent/i);
  assert.deepEqual(group.members, []);
});

test('a failed build leaves the entire structure configurable and permits a later successful build', async () => {
  const first = new Node({ run: () => 'original' });
  const missing = new Node();
  const group = new Group({ run: () => 'group' });
  group.add(first, missing);
  const driver = new Driver();
  assert.throws(() => build(driver, group), /execute|run|configured|definition/i);
  Object.assign(first, { deps: {}, run: () => 'updated' });
  Object.assign(missing, { deps: {}, run: () => 'configured' });
  Object.assign(group, {
    deps: undefined,
    run: async function (work) {
      const calls = [work.children.create(first, null), work.children.create(missing, null)];
      await Promise.all(calls.map((call) => call.run()));
      return Promise.all(calls.map((call) => call.accept()));
    },
  });
  assert.deepEqual(await driver.run(build(driver, group), null, {}), ['updated', 'configured']);
});

test('binding hooks cannot edit or recursively build the reserved structure tree', async () => {
  const child = new Node({ run: () => 'original' });
  const extra = new Node({ run: () => 'extra' });
  const group = new Group({
    async run(work) {
      const call = work.children.create(child, null);
      await call.run();
      return call.accept();
    },
  }).add(child);
  const other = new Group({ run: () => null });
  let checks = 0;
  const driver = new Driver({
    observations: [
      {
        check(structure) {
          if (structure !== group) return;
          checks++;
          assert.throws(() => group.add(extra), /building|build/i);
          assert.throws(() => other.add(child), /building|build/i);
          assert.throws(() => build(driver, group), /building|build/i);
        },
        bindInvocation: () => ({ observe() {} }),
      },
    ],
  });
  const ready = build(driver, group);
  assert.equal(checks, 1);
  assert.deepEqual(group.members, [child]);
  assert.equal(await driver.run(ready, null, {}), 'original');
  assert.doesNotThrow(() => other.add(extra));
});

test('a failed host binding hook releases building reservations on every descendant', async () => {
  const failure = new Error('binding validation failed');
  let fail = true;
  const child = new Node({ run: () => 'original' });
  const group = new Group({ run: () => 'group' }).add(child);
  const driver = new Driver({
    observations: [
      {
        check(structure) {
          if (structure === child && fail) throw failure;
        },
        bindInvocation: () => ({ observe() {} }),
      },
    ],
  });
  assert.throws(
    () => build(driver, group),
    (error) => error === failure,
  );
  assert.throws(() => callableConstruction(group), /not been built/);
  assert.throws(() => callableConstruction(child), /not been built/);
  Object.assign(child, { deps: {}, run: () => 'repaired' });
  Object.assign(group, {
    deps: {},
    run: async function (work) {
      const call = work.children.create(child, null);
      await call.run();
      return call.accept();
    },
  });
  fail = false;
  assert.equal(await driver.run(build(driver, group), null, {}), 'repaired');
});

test('direct configuration mutation by a binding hook rejects the build before installation', async () => {
  let mutate = true;
  const child = new Node({ name: 'original', run: () => 'child' });
  const group = new Group({ run: () => 'group' }).add(child);
  const driver = new Driver({
    observations: [
      {
        check(structure) {
          if (structure === group && mutate) child.name = 'changed during binding';
        },
        bindInvocation: () => ({ observe() {} }),
      },
    ],
  });
  assert.throws(() => build(driver, group), /changed|mutat|configuration/i);
  assert.throws(() => callableConstruction(group), /not been built/);
  assert.throws(() => callableConstruction(child), /not been built/);
  mutate = false;
  Object.assign(child, { name: 'repaired', run: () => 'child' });
  assert.equal(await driver.run(build(driver, group), null, {}), 'group');
});

test('binding rejects rewritten processing fields and preserves the business receiver after repair', async () => {
  const handler = {
    suffix: 'before',
    execute() {
      return `original:${this.suffix}`;
    },
  };
  const child = new Node({ run: handler.execute.bind(handler) });
  const original = child.run;
  let rewrite = true;
  const group = new Group({
    async run(work) {
      const call = work.children.create(child, null);
      await call.run();
      return call.accept();
    },
  }).add(child);
  const driver = new Driver({
    observations: [
      {
        check(structure) {
          if (structure !== group) return;
          if (rewrite) child.run = () => 'replacement';
          handler.suffix = 'after';
        },
        bindInvocation: () => ({ observe() {} }),
      },
    ],
  });
  assert.throws(() => build(driver, group), /configuration changed while building: run/);
  rewrite = false;
  Object.assign(child, { deps: {}, run: original });
  const ready = build(driver, group);
  assert.equal(await driver.run(ready, null, {}), 'original:after');
  handler.suffix = 'later';
  assert.equal(await driver.run(ready, null, {}), 'original:later');
});

test('factory configuration reads inherited getters and keeps the same concrete author objects', async () => {
  const { defineGroup } = await import('@weiliang0121/capix-runtime');
  const child = new Node({ run: (work) => work.input + 1 });
  const handler = {
    offset: 10,
    async execute(work) {
      const call = work.children.create(child, work.input);
      await call.run();
      return call.accept((value) => value + this.offset);
    },
  };
  class Configuration {
    get name() {
      return 'inherited';
    }
    get members() {
      return [child];
    }
    get run() {
      return handler.execute.bind(handler);
    }
  }
  const group = defineGroup()(new Configuration());
  assert.ok(group instanceof Group);
  assert.equal(group.name, 'inherited');
  assert.deepEqual(group.members, [child]);
  const driver = new Driver();
  assert.equal(await driver.run(build(driver, group), 1, {}), 12);
});

test('configuration and build capture one processing function while preserving its receiver', async () => {
  let reads = 0;
  const config = {
    prefix: 'configured:',
    deps: {},
    get run() {
      reads++;
      return function (work) {
        return this.prefix + work.input;
      };
    },
  };
  const node = new Node(config);
  assert.equal(typeof node.run, 'function');
  assert.equal(reads, 1);
  assert.equal(node.deps, config.deps);
  const driver = new Driver();
  const ready = build(driver, node);
  assert.equal(ready, node);
  assert.equal(Object.isFrozen(ready.deps), true);
  assert.notEqual(ready.deps, config.deps);
  config.prefix = 'live:';
  assert.equal(await driver.run(ready, 'input', {}), 'live:input');
  assert.equal(reads, 1);
  for (const field of ['deps', 'run', 'output', 'checkpoint']) assert.equal(Object.getOwnPropertyDescriptor(ready, field).writable, false);
  for (const field of ['setRun', 'setDefinition', 'accept', 'exceptions', 'raises', 'maxRounds', 'uses', 'observation']) assert.equal(field in ready, false);
});
