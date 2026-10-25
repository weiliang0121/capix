import { installCallable } from './fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Group, Node, ResourceOffer, bindResources, bindChildResources, bindCallSource } from '@capix/server-runtime';
import { runtimeDefinition } from './fixtures/declarations.mjs';

function attempt(name, run) {
  return new Node({ name, label: name, source: 'test', callee: 'test', deps: run.deps, uses: run.uses, run: run.execute.bind(run), accept: run.accept?.bind(run) });
}
function operation(name, children, run) {
  return new Group({ name, label: name, source: 'test', deps: run.deps, uses: run.uses, run: run.execute.bind(run), accept: run.accept?.bind(run) }).add(...children);
}
function execution(children, run) {
  return new Group({ deps: run.deps, uses: run.uses, run: run.execute.bind(run), accept: run.accept?.bind(run) }).add(...children);
}

// Offer identities, local aliases, resource captures and business access are separate boundaries.
test('transitive supplies retain offers while parents receive only their own resource views', async () => {
  const captures = { history: 0, model: 0, dormant: 0 };
  const endpoints = [];
  const facts = [];
  const history = new ResourceOffer({ name: 'supply.history', expose: (value) => value });
  const model = new ResourceOffer({
    name: 'supply.model',
    expose: (value, activity) => {
      const endpoint = { read: () => activity.runSync('read', {}, () => value) };
      endpoints.push(endpoint);
      return endpoint;
    },
  });
  const dormant = new ResourceOffer({ name: 'supply.dormant', expose: () => assert.fail('unused descendant must stay lazy') });
  const leaf = attempt('model', { deps: { value: model.request() }, execute: (work) => work.resources.value.read() });
  const unused = attempt('unused', { deps: { value: dormant.request() }, execute: () => null });
  const parent = operation('parent', [leaf, unused], {
    deps: { value: history.request() },
    async execute(work) {
      assert.deepEqual(Object.keys(work.resources), ['value']);
      assert.equal(work.resources.value, 'history');
      return Promise.all([work.children.create(leaf, null).run(), work.children.create(leaf, null).run()]);
    },
  });
  const main = execution([parent], { deps: {}, execute: (work) => work.children.create(parent, null).run() });
  const runtime = installCallable(runtimeDefinition(main), {
    providers: [
      history.provide(() => {
        captures.history++;
        return 'history';
      }),
      model.provide(() => {
        captures.model++;
        return 'model';
      }),
      dormant.provide(() => {
        captures.dormant++;
        return null;
      }),
    ],
    source: { capture: () => null },
    observations: [
      {
        bindInvocation(setup) {
          return {
            observe() {},
            resource(fact) {
              facts.push({ kind: setup.identity.kind, name: setup.description?.name, access: fact.access });
            },
          };
        },
      },
    ],
  });
  assert.deepEqual(captures, { history: 0, model: 0, dormant: 0 });
  assert.deepEqual(await runtime.run(null, {}), ['model', 'model']);
  assert.deepEqual(captures, { history: 1, model: 1, dormant: 0 });
  assert.equal(endpoints.length, 2);
  assert.notEqual(endpoints[0], endpoints[1]);
  const modelFacts = facts.filter((fact) => fact.access === 'supply.model');
  assert.ok(modelFacts.length > 0);
  assert.ok(modelFacts.every((fact) => fact.kind === 'node'));
  assert.ok(!facts.some((fact) => fact.access === 'supply.dormant' || fact.name === undefined));
  for (const endpoint of endpoints) assert.throws(() => endpoint.read(), /ended|running/);
});

test('a pure forwarding operation narrows descendant supply without owning an endpoint or affecting siblings', async () => {
  let captures = 0;
  let exposes = 0;
  let refinements = 0;
  const offer = new ResourceOffer({
    name: 'supply.refined',
    expose: (source, activity) => {
      exposes++;
      return { read: () => activity.runSync('read', {}, () => source) };
    },
    timing: 'access',
    capture(source) {
      captures++;
      return Object.freeze([...source]);
    },
    refine(source, selected) {
      refinements++;
      if (selected.some((value) => !source.includes(value))) throw new Error('Cannot widen access');
      return Object.freeze([...selected]);
    },
  });
  const leaf = attempt('read', { deps: { value: offer.request() }, execute: (work) => work.resources.value.read() });
  const parent = operation('forward', [leaf], {
    deps: {},
    execute(work) {
      assert.deepEqual(Object.keys(work.resources), []);
      return work.children.create(leaf, null).run();
    },
  });
  const main = execution([parent], { deps: {}, execute: (work) => Promise.all(work.input.map((selection) => work.children.create(parent, selection).run())) });
  const runtime = installCallable(runtimeDefinition(main), {
    providers: [offer.provide(() => ['a', 'b'])],
    source: { capture: () => null },
    childResources: [bindChildResources(parent, [offer.refine((selection) => selection)])],
  });
  assert.deepEqual(await runtime.run([['a'], ['b']], {}), [['a'], ['b']]);
  assert.equal(captures, 1);
  assert.equal(refinements, 2);
  assert.equal(exposes, 2);
  await assert.rejects(runtime.run([['outside']], {}), /Cannot widen access/);
  assert.equal(runtime.running, false);
});

test('R and E keep independent capture sources even when they use the same offer', async () => {
  const captures = [];
  const offer = new ResourceOffer({ name: 'supply.boundary', expose: (value) => value, timing: 'binding' });
  const leaf = attempt('leaf', { deps: { value: offer.request() }, execute: (work) => work.resources.value });
  const parent = operation('forward', [leaf], { deps: {}, execute: (work) => work.children.create(leaf, null).run() });
  const main = execution([parent], { deps: {}, execute: (work) => work.children.create(parent, null).run() });
  const definition = runtimeDefinition(main);
  definition.deps = { value: offer.request() };
  definition.run = async function (work) {
    return [work.resources.value, await work.children.create(main, 'prepared').run()];
  };
  const runtime = installCallable(definition, {
    providers: [
      offer.provide((source) => {
        captures.push(source);
        return source;
      }),
    ],
    source: { capture: (input) => `R:${input}` },
    bindings: [bindCallSource(main, { capture: (input) => `E:${input}` })],
  });
  assert.deepEqual(await runtime.run('input', {}), ['R:input', 'E:prepared']);
  assert.deepEqual(captures, ['R:input', 'E:prepared']);
});

test('observation-only supplies never satisfy a business descendant requirement', async () => {
  const offer = new ResourceOffer({ name: 'supply.observer-only', expose: (value) => value });
  const leaf = attempt('leaf', { deps: {}, execute: () => 'ok' });
  leaf.observation = [
    {
      deps: { value: offer.request() },
      observe(_fact, resources) {
        assert.equal(resources.value, 'observer');
      },
    },
  ];
  const parent = operation('parent', [leaf], { deps: {}, execute: (work) => work.children.create(leaf, null).run() });
  const main = execution([parent], { deps: {}, execute: (work) => work.children.create(parent, null).run() });
  const options = {
    providers: [],
    source: { capture: () => null },
    observations: [
      {
        provides: { value: offer.request() },
        bindInvocation() {
          return { observe() {}, resources: bindResources({ value: offer.request() }, [offer.provide(() => 'observer')])(null) };
        },
      },
    ],
  };
  assert.equal(await installCallable(runtimeDefinition(main), options).run(null, {}), 'ok');
  const businessLeaf = attempt('business-leaf', { deps: { value: offer.request() }, execute: (work) => work.resources.value });
  const next = execution([businessLeaf], { deps: {}, execute: (work) => work.children.create(businessLeaf, null).run() });
  assert.throws(() => installCallable(runtimeDefinition(next), options), /Expected one resource provider/);
});

test('identity aggregation still rejects missing, duplicate and name-conflicting providers', () => {
  const first = new ResourceOffer({ name: 'supply.shared-name', expose: (source) => source });
  const second = new ResourceOffer({ name: 'supply.shared-name', expose: (source) => source });
  const leaf = attempt('leaf', { deps: { value: first.request() }, execute: () => null });
  const parent = operation('parent', [leaf], { deps: {}, execute: () => null });
  const main = execution([parent], { deps: {}, execute: () => null });
  const definition = runtimeDefinition(main);
  const source = { capture: () => null };
  assert.throws(() => installCallable(definition, { providers: [], source }), /Expected one resource provider/);
  assert.throws(() => installCallable(definition, { providers: [first.provide(() => null), first.provide(() => null)], source }), /Expected one resource provider/);
  parent.deps = { value: second.request() };
  parent.run = () => null;
  assert.throws(() => installCallable(definition, { providers: [first.provide(() => null), second.provide(() => null)], source }), /Different resource offers/);
});
