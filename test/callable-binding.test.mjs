import { installCallable } from './fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Driver, ResourceOffer, bindChildResources, defineScene, defineGroup, defineNode } from '@capix/server-runtime';
import { CallableBuilder, callableConstruction, createRootInvocation } from '@capix/server-runtime/construction';

function install(definition, options = {}) {
  return installCallable(definition, { providers: [], source: { capture: () => null }, ...options });
}

async function receive(work, member, input) {
  const call = work.children.create(member, input);
  await call.run();
  return call.accept();
}

function delegate(member) {
  return async function (work) {
    return receive(work, member, work.input);
  };
}

test('a root group or node rejects a second source registration instead of silently ignoring it', () => {
  for (const definition of [defineGroup()({ run: () => null }), defineNode()({ run: () => null })]) {
    assert.throws(
      () =>
        new CallableBuilder().build(definition, {
          providers: [],
          source: { capture: () => null },
          bindings: [{ definition, capture: () => 'unused' }],
        }),
      /root callable source/,
    );
  }
});

test('scene, nested groups and nodes execute their own work through the shared callable lifecycle', async () => {
  const executed = [];
  const result = { value: 42 };
  const unused = defineNode()({
    run() {
      assert.fail('registration cannot schedule an unused member');
    },
  });
  const node = defineNode()({
    run(work) {
      assert.equal('children' in work, false);
      executed.push('node');
      return result;
    },
  });
  const inner = defineGroup()({
    members: [node, unused],
    async run(work) {
      executed.push('inner');
      return receive(work, node, work.input);
    },
  });
  const outer = defineGroup()({
    members: [inner],
    async run(work) {
      executed.push('outer');
      return receive(work, inner, work.input);
    },
  });
  const scene = defineScene()({
    members: [outer],
    async run(work) {
      executed.push('scene');
      return receive(work, outer, work.input);
    },
  });
  const kinds = [];
  const driver = install(scene, {
    source: {
      capture: () => null,
      progress: () => ({
        receive: (fact) => {
          if (fact.kind === 'started') kinds.push(fact.identity.kind);
        },
      }),
    },
  });
  assert.equal(await driver.run('input', {}), result);
  assert.deepEqual(executed, ['scene', 'outer', 'inner', 'node']);
  assert.deepEqual(kinds, ['scene', 'group', 'group', 'node']);
});

test('one fixed supply is shared while each call receives its own revocable resource endpoint', async () => {
  let rootCaptures = 0;
  let resolves = 0;
  const endpoints = [];
  const source = { value: 7 };
  const offer = new ResourceOffer({
    name: 'callable.shared',
    expose: (value, activity) => {
      const endpoint = { read: () => activity.runSync('read', {}, () => value) };
      endpoints.push(endpoint);
      return endpoint;
    },
  });
  const node = defineNode()({ deps: { data: offer.request() }, run: (work) => work.resources.data.read() });
  const group = defineGroup()({
    members: [node],
    async run(work) {
      assert.deepEqual(Object.keys(work.resources), []);
      return Promise.all([receive(work, node, 1), receive(work, node, 2)]);
    },
  });
  const driver = install(defineScene()({ members: [group], run: delegate(group) }), {
    providers: [
      offer.provide((value) => {
        resolves++;
        return value;
      }),
    ],
    source: {
      capture: () => {
        rootCaptures++;
        return source;
      },
    },
  });
  assert.equal(resolves, 0);
  assert.deepEqual(await driver.run(null, {}), [source, source]);
  assert.equal(rootCaptures, 1);
  assert.equal(resolves, 1);
  assert.equal(endpoints.length, 2);
  assert.notEqual(endpoints[0], endpoints[1]);
  for (const endpoint of endpoints) assert.throws(() => endpoint.read(), /running|ended|closed/);
});

test('explicit sources can be attached to a deep group or node and do not depend on a special first layer', async () => {
  const captures = [];
  const starts = [];
  const offer = new ResourceOffer({ name: 'callable.source', expose: (value) => value });
  const inherited = defineNode()({ deps: { value: offer.request() }, run: (work) => work.resources.value });
  const rootReader = defineNode()({ deps: { value: offer.request() }, run: (work) => work.resources.value });
  const independent = defineNode()({ deps: { value: offer.request() }, run: (work) => work.resources.value });
  const target = defineGroup()({
    members: [inherited, independent],
    async run(work) {
      assert.deepEqual(Object.keys(work.resources), []);
      return [await receive(work, inherited, null), await receive(work, independent, 'leaf')];
    },
  });
  const wrapper = defineGroup()({ members: [target], run: delegate(target) });
  const scene = defineScene()({
    members: [wrapper, rootReader],
    async run(work) {
      return [await receive(work, rootReader, null), await receive(work, wrapper, 'task')];
    },
  });
  const driver = install(scene, {
    providers: [offer.provide((value) => value)],
    source: { capture: () => 'root' },
    bindings: [
      {
        definition: target,
        capture: (input, options) => {
          captures.push(input);
          return `${options.tag}:${input}`;
        },
        started: () => (context) => {
          starts.push(context.kind);
        },
      },
      { definition: independent, capture: (input) => `node:${input}` },
    ],
  });
  assert.deepEqual(await driver.run(null, { tag: 'fixed' }), ['root', ['fixed:task', 'node:leaf']]);
  assert.deepEqual(captures, ['task']);
  assert.deepEqual(starts, ['group']);
});

test('a source boundary failure preserves its parent facts without attaching a fabricated child', async () => {
  const target = defineNode()({
    run() {
      assert.fail('failed source must not execute');
    },
  });
  const group = defineGroup()({ members: [target], run: delegate(target) });
  const started = [];
  const driver = install(defineScene()({ members: [group], run: delegate(group) }), {
    bindings: [
      {
        definition: target,
        capture() {
          throw new Error('source unavailable');
        },
      },
    ],
    source: {
      capture: () => null,
      progress: () => ({
        receive: (fact) => {
          if (fact.kind === 'started') started.push(fact.identity.kind);
        },
      }),
    },
  });
  await assert.rejects(driver.run(null, {}), /source unavailable/);
  assert.deepEqual(started, ['scene', 'group']);
  assert.equal(driver.running, false);
});

test('resource narrowing stays local even when the parent has no endpoint for the supplied resource', async () => {
  let captures = 0;
  const offer = new ResourceOffer({
    name: 'callable.narrow',
    expose: (values) => values,
    timing: 'access',
    capture(values) {
      captures++;
      return Object.freeze([...values]);
    },
    refine(values, wanted) {
      if (wanted.some((value) => !values.includes(value))) throw new Error('widening denied');
      return Object.freeze([...wanted]);
    },
  });
  const node = defineNode()({ deps: { values: offer.request() }, run: (work) => work.resources.values });
  const rootReader = defineNode()({ deps: { values: offer.request() }, run: (work) => work.resources.values });
  const group = defineGroup()({ members: [node], run: delegate(node) });
  const scene = defineScene()({
    members: [group, rootReader],
    async run(work) {
      return [await receive(work, group, ['a']), await receive(work, rootReader, null)];
    },
  });
  const driver = install(scene, { providers: [offer.provide((source) => source)], source: { capture: () => ['a', 'b'] }, childResources: [bindChildResources(group, [offer.refine((input) => input)])] });
  assert.deepEqual(await driver.run(null, {}), [['a'], ['a', 'b']]);
  assert.equal(captures, 1);
});

test('a driver keeps occupancy on its built callable and constructor failure releases it', async () => {
  let finish;
  const waiting = new Promise((resolve) => {
    finish = resolve;
  });
  const scene = defineScene()({ run: () => waiting });
  const driver = new Driver();
  const bound = driver.build(scene, {
    providers: [],
    source: {
      capture: (_input, options) => {
        if (options.fail) throw new Error('setup failed');
        return null;
      },
    },
  });
  await assert.rejects(driver.run(bound, null, { fail: true }), /setup failed/);
  assert.equal(driver.isRunning(bound), false);
  const running = driver.run(bound, null, {});
  assert.equal(driver.isRunning(bound), true);
  await assert.rejects(driver.run(bound, null, {}), (error) => error.code === 'RUNTIME_BUSY');
  finish('done');
  assert.equal(await running, 'done');
  assert.equal(driver.isRunning(bound), false);
});

test('call construction scopes are authenticated to their exact bound installation', () => {
  const builder = new CallableBuilder();
  const first = builder.build(defineScene()({ run: () => null }), { providers: [], source: { capture: () => null } });
  const second = builder.build(defineScene()({ run: () => null }), { providers: [], source: { capture: () => null } });
  const own = callableConstruction(first).calls.begin({});
  assert.throws(() => callableConstruction(second).calls.require(own), /another binding installation/);
  assert.throws(() => callableConstruction(first).calls.require({}), /another binding installation/);
  assert.doesNotThrow(() => createRootInvocation(first, null, {}, {}));
});

test('binding rejects node members, undeclared source targets and duplicate registrations', () => {
  const node = defineNode()({ run: () => null });
  const illegal = Object.assign(node, { members: [] });
  const scene = defineScene()({ members: [illegal], run: delegate(illegal) });
  assert.throws(() => install(scene), /Nodes cannot declare members/);
  delete node.members;
  const other = defineNode()({ run: () => null });
  assert.throws(() => install(scene, { bindings: [{ definition: other, capture: () => null }] }), /registered member/);
  assert.throws(() => install(scene, { bindings: [{ definition: node }, { definition: node }] }), /Duplicate callable source/);
});

test('host source methods and receivers are fixed during binding without freezing host state', async () => {
  const offer = new ResourceOffer({ name: 'callable.fixed-source', expose: (value) => value });
  const scene = defineScene()({ deps: { value: offer.request() }, run: (work) => work.resources.value });
  const source = {
    value: 'initial',
    capture() {
      return this.value;
    },
  };
  const driver = install(scene, { providers: [offer.provide((value) => value)], source });
  source.capture = () => assert.fail('replacement source method is not part of the installed binding');
  source.value = 'live host value';
  assert.equal(await driver.run(null, {}), 'live host value');
  assert.equal(Object.isFrozen(source), false);
});

test('a pre-cancelled entry releases occupancy without capturing a host source', async () => {
  let captured = 0;
  const driver = install(defineScene()({ run: () => 'done' }), {
    source: {
      capture: () => {
        captured++;
        return null;
      },
    },
  });
  await assert.rejects(driver.run(null, { signal: AbortSignal.abort('cancelled') }), { code: 'INVOCATION_CANCELLED' });
  assert.equal(captured, 0);
  assert.equal(driver.running, false);
  assert.equal(await driver.run(null, {}), 'done');
  assert.equal(captured, 1);
});

test('same-signature members retain exact phase authorization independently of their structural types', async () => {
  let called = 0;
  const allowed = defineNode()({ run: () => 1 });
  const other = defineNode()({
    run: () => {
      called++;
      return 2;
    },
  });
  const scene = defineScene()({
    members: [allowed, other],
    uses: [allowed],
    run(work) {
      try {
        work.children.create(other, null);
      } catch {}
      return 'cannot hide this violation';
    },
  });
  await assert.rejects(install(scene).run(null, {}), /not allowed|not declared|phase/i);
  assert.equal(called, 0);
});
