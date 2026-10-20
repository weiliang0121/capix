import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Driver, Scene, Group, Node, ResourceOffer, checkpointPoint } from '@capix/server-runtime';

const bind = (driver, structure, providers = []) => driver.bind(structure, { providers, source: { capture: () => null } });
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
  assert.equal(await driver.run(bind(driver, direct), null, {}), result);
  assert.equal(await driver.run(bind(driver, configured), null, {}), result);
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
  assert.equal(await driver.run(bind(driver, scene), 4, {}), 13);
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
  const bound = bind(driver, group);
  assert.equal(bound.children.position(left), 0);
  assert.equal(bound.children.position(right), 1);
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
  await assert.rejects(driver.run(bind(driver, group), null, {}), /different declaration/);
});

test('membership edits and phase replacement affect later bindings, not already installed structures', async () => {
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
  const installed = bind(driver, group);
  group.add(second);
  group.setRun({
    uses: [second],
    async execute(work) {
      const child = work.children.create(second, work.input);
      await child.run();
      return child.accept();
    },
  });
  first.setRun({ execute: () => 'changed later' });
  assert.equal(await driver.run(installed, 1, {}), 'first:1');
  assert.equal(installed.children.definitions().length, 1);
  assert.equal(await driver.run(bind(driver, group), 2, {}), 'second:2');
});

test('setRun replaces the complete phase resource contract and preserves each binding supply', async () => {
  const oldOffer = new ResourceOffer('structures.old', (value) => value);
  const newOffer = new ResourceOffer('structures.new', (value) => value);
  const node = new Node();
  node.setRun({ requires: { old: oldOffer.request() }, execute: (work) => work.resources.old });
  const first = new Driver();
  const installed = bind(first, node, [oldOffer.provide(() => 'old')]);
  node.setRun({ requires: { next: newOffer.request() }, execute: (work) => work.resources.next });
  const second = new Driver();
  const next = bind(second, node, [newOffer.provide(() => 'new')]);
  assert.equal(await first.run(installed, null, {}), 'old');
  assert.equal(await second.run(next, null, {}), 'new');
  assert.throws(() => bind(second, node, [oldOffer.provide(() => 'old')]), /resource provider/);
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
  assert.equal(await driver.run(bind(driver, group), null, {}), 'new');
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
  const a = bind(driver, constructor);
  const b = bind(driver, setter);
  handler.count = 10;
  handler.execute = () => assert.fail('bound work must retain the previous entry');
  assert.equal(await driver.run(a, 1, {}), 12);
  assert.equal(await driver.run(b, 1, {}), 13);
  assert.equal(Object.isFrozen(handler), false);
});

test('unconfigured structures and uses outside the added members fail before execution', () => {
  const driver = new Driver();
  assert.throws(() => bind(driver, new Node()), /execute|run|configured|definition/i);
  const child = new Node({ run: { execute: () => 'never' } });
  const group = new Group();
  group.setRun({ uses: [child], execute: () => 'never' });
  assert.throws(() => bind(driver, group), /outside|member/i);
  group.add(child);
  assert.doesNotThrow(() => bind(driver, group));
});

test('setRun replaces a subclass field without keeping a second hidden definition', async () => {
  class Custom extends Node {
    run = { requires: {}, execute: () => 'original' };
  }
  const node = new Custom();
  const driver = new Driver();
  const installed = bind(driver, node);
  node.setRun({ execute: () => 'replacement' });
  assert.equal(await driver.run(installed, null, {}), 'original');
  assert.equal(await driver.run(bind(driver, node), null, {}), 'replacement');
});

test('invalid replacement leaves the previously configured stage and metadata intact', async () => {
  const node = new Node({ name: 'original', run: { execute: () => 'original' } });
  assert.throws(() => node.setRun({ execute: null }), /execute/);
  assert.throws(() => node.setDefinition({ name: 'replacement', run: { execute: () => 'replacement' }, exceptions: { accepts: [], handle: null } }), /exceptions|handle/);
  assert.throws(() => node.setDefinition({ kind: 'group', run: { execute: () => null } }), /kind/);
  assert.equal(node.kind, 'node');
  assert.equal(node.name, 'original');
  const driver = new Driver();
  assert.equal(await driver.run(bind(driver, node), null, {}), 'original');
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
  assert.equal(await driver.run(bind(driver, group), 1, {}), 12);
});
