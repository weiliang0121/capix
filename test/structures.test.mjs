import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Driver, Scene, Group, Node, ResourceOffer, MemoryCheckpointStore, checkpointPoint } from '@capix/server-runtime';
import { CallableBuilder, callableConstruction, createRootInvocation } from '@capix/server-runtime/construction';

const build = (driver, structure, providers = []) => driver.build(structure, { providers, source: { capture: () => null } });
const codec = { encode: (value) => value, decode: (value) => value };

test('constructors and setters configure the same callable objects without executing business work', async () => {
  let calls = 0;
  const result = { answer: 42 };
  const definition = {
    run: {
      execute: () => {
        calls++;
        return result;
      },
    },
  };
  const direct = new Node(definition);
  const configured = new Node();
  configured.setDefinition(definition);
  assert.notEqual(direct, configured);
  assert.equal(calls, 0);
  const driver = new Driver();
  assert.equal(await driver.run(build(driver, direct), null, {}), result);
  assert.equal(await driver.run(build(driver, configured), null, {}), result);
  assert.equal(calls, 2);
});

test('local structures compose with add while each composite explicitly runs and accepts its children', async () => {
  const events = [];
  const leaf = new Node({
    run: {
      execute: (work) => {
        events.push('node');
        return work.input + 1;
      },
    },
  });
  const unused = new Node({ run: { execute: () => assert.fail('add must not schedule members') } });
  const group = new Group();
  group.add(leaf, unused);
  group.setRun({
    uses: [leaf],
    async execute(work) {
      events.push('group');
      const child = work.children.create(leaf, work.input);
      await child.run();
      return child.accept((value) => value * 2);
    },
  });
  const scene = new Scene();
  scene.add(group);
  scene.setRun({
    uses: [group],
    async execute(work) {
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
  const config = { run: { execute: (work) => work.input } };
  const left = new Node(config);
  const right = new Node(config);
  const group = new Group();
  group.add(left, right, left);
  assert.deepEqual(group.members, [left, right]);
  group.setRun({
    uses: [left, right],
    async execute(work) {
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
  const left = new Node({ run: { execute: () => 'left' } });
  const right = new Node({ run: { execute: () => 'right' } });
  const group = new Group();
  group.add(left, right);
  group.setRun({
    uses: [left, right],
    async execute(work) {
      const child = work.children.create(right, null);
      await child.run();
      return work.children.facts.require(left, child.ref);
    },
  });
  const driver = new Driver();
  await assert.rejects(driver.run(build(driver, group), null, {}), /different declaration/);
});

test('successful build locks the whole structure while retaining its original identity', async () => {
  const first = new Node({ run: { execute: (work) => `first:${work.input}` } });
  const second = new Node({ run: { execute: (work) => `second:${work.input}` } });
  const group = new Group();
  group.add(first);
  group.setRun({
    uses: [first],
    async execute(work) {
      const child = work.children.create(first, work.input);
      await child.run();
      return child.accept();
    },
  });
  const driver = new Driver();
  const installed = build(driver, group);
  assert.equal(installed, group);
  assert.throws(() => group.add(second), /locked|built|build/i);
  assert.throws(() => group.add(first), /locked|built|build/i);
  assert.throws(() => group.setRun({ execute: () => 'replacement' }), /locked|built|build/i);
  assert.throws(() => group.setDefinition({ run: { execute: () => 'replacement' } }), /locked|built|build/i);
  assert.throws(() => first.setRun({ execute: () => 'changed later' }), /locked|built|build/i);
  assert.throws(() => {
    group.members = [second];
  }, TypeError);
  assert.throws(() => {
    first.run = { execute: () => 'replacement' };
  }, TypeError);
  assert.throws(() => {
    first.name = 'replacement';
  }, TypeError);
  assert.equal(await driver.run(installed, 1, {}), 'first:1');
  assert.equal(callableConstruction(installed).binding.children.definitions().length, 1);
  assert.throws(() => build(driver, group), /built|build|install|locked/i);
  assert.throws(() => build(new Driver(), group), /built|build|install|locked/i);
  const another = new Group({ run: { execute: () => null } });
  assert.doesNotThrow(() => another.add(second));
});

test('configuration replacement before build selects the final resource contract', async () => {
  const oldOffer = new ResourceOffer('structures.old', (value) => value);
  const newOffer = new ResourceOffer('structures.new', (value) => value);
  const node = new Node();
  node.setRun({ requires: { old: oldOffer.request() }, execute: (work) => work.resources.old });
  node.setRun({ requires: { next: newOffer.request() }, execute: (work) => work.resources.next });
  const driver = new Driver();
  assert.throws(() => build(driver, node, [oldOffer.provide(() => 'old')]), /resource provider/);
  const ready = build(driver, node, [newOffer.provide(() => 'new')]);
  assert.equal(await driver.run(ready, null, {}), 'new');
});

test('setDefinition replaces optional business mechanisms while preserving add membership', async () => {
  const child = new Node({ run: { execute: () => null } });
  const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { execute: () => null } });
  const group = new Group({
    name: 'old',
    maxRounds: 2,
    checkpoint: { key: 'structures.old', version: 1, input: codec, output: codec, points: [point] },
    observation: [],
    output: { result: (value) => value, delta: (value) => value },
    run: { execute: () => 'old', accept: (work) => work.delivered },
  });
  group.add(child);
  group.setDefinition({ run: { execute: () => 'new' } });
  assert.deepEqual(group.members, [child]);
  assert.equal(group.name, undefined);
  assert.equal(group.checkpoint, undefined);
  assert.equal(group.output, undefined);
  assert.equal(group.observation, undefined);
  assert.equal(group.maxRounds, 1);
  assert.equal(group.run.accept, undefined);
  const driver = new Driver();
  assert.equal(await driver.run(build(driver, group), null, {}), 'new');
});

test('constructor and setter preserve business receivers without freezing the host object', async () => {
  const handler = {
    count: 0,
    execute(work) {
      this.count++;
      return this.count + work.input;
    },
  };
  const constructor = new Node({ run: handler });
  const setter = new Node();
  setter.setRun(handler);
  const driver = new Driver();
  const a = build(driver, constructor);
  const b = build(driver, setter);
  handler.count = 10;
  handler.execute = () => assert.fail('bound work must retain the previous entry');
  assert.equal(await driver.run(a, 1, {}), 12);
  assert.equal(await driver.run(b, 1, {}), 13);
  assert.equal(Object.isFrozen(handler), false);
});

test('unconfigured structures and uses outside the added members fail before execution', () => {
  const driver = new Driver();
  assert.throws(() => build(driver, new Node()), /execute|run|configured|definition/i);
  const child = new Node({ run: { execute: () => 'never' } });
  const group = new Group();
  group.setRun({ uses: [child], execute: () => 'never' });
  assert.throws(() => build(driver, group), /outside|member/i);
  group.add(child);
  assert.doesNotThrow(() => build(driver, group));
});

test('setRun replaces a subclass field without keeping a second hidden definition', async () => {
  class Custom extends Node {
    run = { requires: {}, execute: () => 'original' };
  }
  const node = new Custom();
  const driver = new Driver();
  node.setRun({ execute: () => 'replacement' });
  const installed = build(driver, node);
  assert.equal(installed, node);
  assert.equal(await driver.run(installed, null, {}), 'replacement');
  assert.throws(() => node.setRun({ execute: () => 'too late' }), /locked|built|build/i);
});

test('invalid replacement leaves the previously configured stage and metadata intact', async () => {
  const node = new Node({ name: 'original', run: { execute: () => 'original' } });
  assert.throws(() => node.setRun({ execute: null }), /execute/);
  assert.throws(() => node.setDefinition({ name: 'replacement', run: { execute: () => 'replacement' }, exceptions: { accepts: [], handle: null } }), /exceptions|handle/);
  assert.throws(() => node.setDefinition({ kind: 'group', run: { execute: () => null } }), /kind/);
  assert.equal(node.kind, 'node');
  assert.equal(node.name, 'original');
  const driver = new Driver();
  assert.equal(await driver.run(build(driver, node), null, {}), 'original');
});

test('add rejects invalid membership and cycles without partially installing an argument list', () => {
  const node = new Node({ run: { execute: () => null } });
  const scene = new Scene({ run: { execute: () => null } });
  const group = new Group({ run: { execute: () => null } });
  assert.equal(node.add, undefined);
  assert.throws(() => group.add(node, scene), /member|kind|scene/i);
  assert.deepEqual(group.members, []);
  assert.throws(() => group.add(group), /cyclic|cycle|itself/i);
  const child = new Group({ run: { execute: () => null } });
  group.add(child);
  assert.throws(() => child.add(group), /cyclic|cycle/i);
  assert.deepEqual(child.members, []);
});

test('a member has one structural parent and a failed batch claims none of its free members', () => {
  const member = new Node({ run: { execute: () => null } });
  const free = new Node({ run: { execute: () => null } });
  const first = new Group({ run: { execute: () => null } });
  const second = new Group({ run: { execute: () => null } });
  first.add(member, member);
  first.add(member);
  assert.deepEqual(first.members, [member]);
  assert.throws(() => second.add(free, member), /parent/i);
  assert.deepEqual(second.members, []);
  const third = new Group({ run: { execute: () => null } });
  third.add(free);
  assert.deepEqual(third.members, [free]);
  assert.throws(() => {
    second.members = [member];
  }, TypeError);
});

test('a nested group cannot acquire another parent while its member ownership stays intact', () => {
  const node = new Node({ run: { execute: () => null } });
  const nested = new Group({ run: { execute: () => null } });
  nested.add(node);
  const scene = new Scene({ run: { execute: () => null } });
  scene.add(nested);
  const other = new Scene({ run: { execute: () => null } });
  assert.throws(() => other.add(nested), /parent/i);
  assert.throws(() => other.add(node), /parent/i);
  assert.deepEqual(scene.members, [nested]);
  assert.deepEqual(nested.members, [node]);
  assert.deepEqual(other.members, []);
});

test('a prototype clone cannot inherit the configuration identity of another structure', () => {
  const original = new Node({ run: { execute: () => null } });
  const forged = Object.create(original);
  const group = new Group({ run: { execute: () => null } });
  assert.throws(() => group.add(forged), /initialized|configuration/i);
  assert.deepEqual(group.members, []);
  assert.throws(() => build(new Driver(), forged), /initialized|configuration/i);
  assert.doesNotThrow(() => group.add(original));
});

test('a rejected proxy does not claim membership or reserve the real structure for construction', async () => {
  const original = new Node({ run: { execute: () => 'original' } });
  const proxy = new Proxy(original, {});
  const first = new Node({ run: { execute: () => 'first' } });
  const group = new Group({ run: { execute: () => null } });
  assert.throws(() => group.add(first, proxy), /proxies/i);
  assert.deepEqual(group.members, []);
  const other = new Group({ run: { execute: () => null } });
  assert.doesNotThrow(() => other.add(first));
  const driver = new Driver();
  assert.throws(() => build(driver, proxy), /proxies/i);
  assert.throws(() => callableConstruction(original), /not been built/);
  assert.equal(await driver.run(build(driver, original), null, {}), 'original');
});

test('a nonconfigurable members accessor cannot leave a partly installed structure tree', () => {
  const child = new Node({ run: { execute: () => null } });
  const group = new Group({ run: { execute: () => null } }).add(child);
  Object.defineProperty(group, 'members', { get: () => [child], configurable: false });
  assert.throws(() => build(new Driver(), group), /members.*fixed|fixed.*members/i);
  assert.throws(() => callableConstruction(group), /not been built/);
  assert.throws(() => callableConstruction(child), /not been built/);
  assert.doesNotThrow(() => child.setRun({ execute: () => 'still configurable' }));
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
  const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { execute: (_work, state) => state } });
  const node = new Node({
    checkpoint: { key: 'structures.mechanisms', version: 1, input: codec, output: codec, points: [point] },
    run: {
      execute(work) {
        work.checkpoint.save(point, 'result', {});
        return 'result';
      },
    },
  });
  const ready = builder.build(node, { providers: [], source: { capture: () => null } });
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
  const node = new Node({ run: { execute: () => null } });
  build(new Driver(), node);
  const group = new Group({ run: { execute: () => null } });
  assert.throws(() => group.add(node), /built|build|parent/i);
  assert.deepEqual(group.members, []);
});

test('a failed build leaves the entire structure configurable and permits a later successful build', async () => {
  const first = new Node({ run: { execute: () => 'original' } });
  const missing = new Node();
  const group = new Group({ run: { execute: () => 'group' } });
  group.add(first, missing);
  const driver = new Driver();
  assert.throws(() => build(driver, group), /execute|run|configured|definition/i);
  first.setRun({ execute: () => 'updated' });
  missing.setRun({ execute: () => 'configured' });
  group.setRun({
    uses: [first, missing],
    async execute(work) {
      const calls = [work.children.create(first, null), work.children.create(missing, null)];
      await Promise.all(calls.map((call) => call.run()));
      return Promise.all(calls.map((call) => call.accept()));
    },
  });
  assert.deepEqual(await driver.run(build(driver, group), null, {}), ['updated', 'configured']);
});

test('binding hooks cannot edit or recursively build the reserved structure tree', async () => {
  const child = new Node({ run: { execute: () => 'original' } });
  const extra = new Node({ run: { execute: () => 'extra' } });
  const group = new Group({
    run: {
      async execute(work) {
        const call = work.children.create(child, null);
        await call.run();
        return call.accept();
      },
    },
  }).add(child);
  const other = new Group({ run: { execute: () => null } });
  let checks = 0;
  const driver = new Driver({
    observations: [
      {
        check(structure) {
          if (structure !== group) return;
          checks++;
          assert.throws(() => group.add(extra), /building|build/i);
          assert.throws(() => child.setRun({ execute: () => 'replacement' }), /building|build/i);
          assert.throws(() => child.setDefinition({ run: { execute: () => 'replacement' } }), /building|build/i);
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
  const child = new Node({ run: { execute: () => 'original' } });
  const group = new Group({ run: { execute: () => 'group' } }).add(child);
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
  child.setRun({ execute: () => 'repaired' });
  group.setRun({
    async execute(work) {
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
  const child = new Node({ name: 'original', run: { execute: () => 'child' } });
  const group = new Group({ run: { execute: () => 'group' } }).add(child);
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
  child.setDefinition({ name: 'repaired', run: { execute: () => 'child' } });
  assert.equal(await driver.run(build(driver, group), null, {}), 'group');
});

test('binding hooks cannot rewrite an already resolved nested entry while its business receiver remains mutable', async () => {
  const handler = {
    suffix: 'before',
    execute() {
      return `original:${this.suffix}`;
    },
  };
  const child = new Node({ run: handler });
  const group = new Group({
    run: {
      async execute(work) {
        const call = work.children.create(child, null);
        await call.run();
        return call.accept();
      },
    },
  }).add(child);
  const driver = new Driver({
    observations: [
      {
        check(structure) {
          if (structure !== group) return;
          child.run.execute = () => 'replacement';
          handler.suffix = 'after';
        },
        bindInvocation: () => ({ observe() {} }),
      },
    ],
  });
  const ready = build(driver, group);
  assert.equal(await driver.run(ready, null, {}), 'original:after');
  handler.suffix = 'later';
  assert.equal(await driver.run(ready, null, {}), 'original:later');
});

test('factory configuration reads inherited getters and keeps the same concrete author objects', async () => {
  const { defineGroup } = await import('@capix/server-runtime');
  const child = new Node({ run: { execute: (work) => work.input + 1 } });
  const handler = {
    offset: 10,
    uses: [child],
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
      return handler;
    }
  }
  const group = defineGroup()(new Configuration());
  assert.ok(group instanceof Group);
  assert.equal(group.name, 'inherited');
  assert.deepEqual(group.members, [child]);
  const driver = new Driver();
  assert.equal(await driver.run(build(driver, group), 1, {}), 12);
});
