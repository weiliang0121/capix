import { installCallable } from './fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, Node, ResourceOffer, MemoryCheckpointStore, defineObservation } from '@capix/server-runtime';
import { runtimeDefinition } from './fixtures/declarations.mjs';

function attempt(name, run) {
  return new Node({ name, label: name, source: 'test', deps: run.deps, run: run.execute.bind(run) });
}

function operation(name, children, run) {
  return new Group({ name, label: name, source: 'test', deps: run.deps, run: run.execute.bind(run) }).add(...children);
}

function execution(children, run) {
  return new Group({ deps: run.deps, run: run.execute.bind(run) }).add(...children);
}

function assemble(definition, options = {}) {
  return installCallable(definition, { providers: [], source: { capture: () => null }, ...options });
}

test('declaration checks finish once per structure before any call and never repeat during invocation construction', async () => {
  const checked = [];
  const called = [];
  const parent = (name) => {
    const leaf = attempt('leaf', { deps: {}, execute: (context) => context.input });
    const shared = operation('shared', [leaf], { deps: {}, execute: (context) => context.children.create(leaf, context.input).run() });
    return operation(name, [shared], { deps: {}, execute: (context) => context.children.create(shared, context.input).run() });
  };
  const left = parent('left');
  const right = parent('right');
  const main = execution([left, right], { deps: {}, execute: (context) => context.children.create(context.input === 'right' ? right : left, context.input).run() });
  const definition = runtimeDefinition(main);
  const runtime = assemble(definition, {
    observations: [
      {
        check(scope, owner) {
          checked.push([scope.kind, scope.name, owner?.kind, owner?.name]);
        },
        bindInvocation(setup) {
          called.push({ ...setup.identity, description: setup.description });
          return { observe() {} };
        },
      },
    ],
  });
  assert.deepEqual(checked, [
    ['scene', undefined, undefined, undefined],
    ['group', undefined, 'scene', undefined],
    ['group', 'left', 'group', undefined],
    ['group', 'shared', 'group', 'left'],
    ['node', 'leaf', 'group', 'shared'],
    ['group', 'right', 'group', undefined],
    ['group', 'shared', 'group', 'right'],
    ['node', 'leaf', 'group', 'shared'],
  ]);
  const initialChecks = checked.slice();
  assert.equal(called.length, 0);
  for (const input of ['left', 'right', 'left']) assert.equal(await runtime.run(input, {}), input);
  assert.deepEqual(checked, initialChecks);
  const sharedCalls = called.filter((call) => call.description?.name === 'shared');
  assert.equal(sharedCalls.length, 3);
  assert.equal(typeof sharedCalls[0].description.id, 'string');
  assert.notEqual(sharedCalls[0].description.id, sharedCalls[1].description.id);
  assert.equal(sharedCalls[0].description.id, sharedCalls[2].description.id);
  assert.equal(new Set(sharedCalls.map((call) => call.contextId)).size, 3);
});

test('nodes sharing behavior use the root supply without granting it to their parents', async () => {
  const value = new ResourceOffer({ name: 'test.resolution.parent-scope', expose: (source) => source, timing: 'binding' });
  const deps = { value: value.request() };
  let captures = 0;
  const behavior = { deps, execute: (work) => work.resources.value };
  const parent = (name) => {
    const child = attempt('shared', behavior);
    return operation(name, [child], {
      deps: {},
      execute(work) {
        assert.deepEqual(Object.keys(work.resources), []);
        return work.children.create(child, work.input).run();
      },
    });
  };
  const left = parent('left');
  const right = parent('right');
  const main = execution([left, right], { deps: {}, execute: (work) => Promise.all([work.children.create(left, null).run(), work.children.create(right, null).run()]) });
  const runtime = assemble(runtimeDefinition(main), { providers: [value.provide(() => ++captures)] });
  assert.equal(captures, 0);
  assert.deepEqual(await runtime.run(null, {}), [1, 1]);
  assert.equal(captures, 1);
  const missing = execution([parent('missing')], { deps: {}, execute: () => null });
  assert.throws(() => assemble(runtimeDefinition(missing)), /Expected one resource provider/);
});

test('built children, resource aliases and work functions stay fixed while business instances remain live', async () => {
  const oldResource = new ResourceOffer({ name: 'test.resolution.original', expose: (value) => value });
  const newResource = new ResourceOffer({ name: 'test.resolution.replacement', expose: (value) => value });
  const originalRequires = { value: oldResource.request() };
  const replacementRequires = { replacement: newResource.request() };
  const originalLeaf = attempt('original-leaf', { deps: originalRequires, execute: (context) => `${context.input}:${context.resources.value}` });
  const originalOperation = operation('original-operation', [originalLeaf], { deps: originalRequires, execute: (context) => context.children.create(originalLeaf, context.input).run() });
  const replacementLeaf = attempt('replacement-leaf', { deps: replacementRequires, execute: (context) => `${context.input}:${context.resources.replacement}` });
  const replacementOperation = operation('replacement-operation', [replacementLeaf], { deps: replacementRequires, execute: (context) => context.children.create(replacementLeaf, context.input).run() });
  class Main extends Group {
    #prefix = 'initial';
    deps = originalRequires;
    run = this.execute.bind(this);
    constructor() {
      super();
      this.add(originalOperation);
    }
    setPrefix(value) {
      this.#prefix = value;
    }
    execute(context) {
      return context.children.create(originalOperation, `${this.#prefix}:${context.input}`).run();
    }
  }
  const main = new Main();
  const definition = runtimeDefinition(main);
  let captured = 0;
  const options = {
    providers: [
      oldResource.provide(() => {
        captured++;
        return 'old';
      }),
      newResource.provide(() => 'new'),
    ],
  };
  const existing = assemble(definition, options);
  assert.equal(captured, 0);
  main.setPrefix('live');
  assert.throws(() => main.members.splice(0, 1, replacementOperation), TypeError);
  assert.throws(() => {
    main.deps = replacementRequires;
  }, TypeError);
  assert.throws(() => {
    main.run = () => assert.fail('replacement work');
  }, TypeError);
  originalRequires.value = newResource.request();
  assert.throws(() => {
    originalOperation.members.length = 0;
  }, TypeError);
  assert.throws(() => {
    originalOperation.run = () => null;
  }, TypeError);
  assert.throws(() => {
    originalLeaf.run = () => null;
  }, TypeError);
  assert.equal(await existing.run('first', {}), 'live:first:old');
  assert.equal(await existing.run('second', {}), 'live:second:old');
  assert.equal(captured, 2);
  assert.equal(Object.isFrozen(main), false);
  const replacement = execution([replacementOperation], { deps: replacementRequires, execute: (work) => work.children.create(replacementOperation, `replacement:${work.input}`).run() });
  assert.equal(await assemble(runtimeDefinition(replacement), options).run('third', {}), 'replacement:third:new');
});

test('fixed run callbacks keep their original receiver without freezing its business state', async () => {
  const run = {
    calls: 0,
    deps: {},
    execute(context) {
      this.calls++;
      return `${this.calls}:${context.input}`;
    },
  };
  const definition = runtimeDefinition(execution([], run));
  const runtime = assemble(definition);
  run.execute = () => 'replacement';
  run.calls = 10;
  assert.equal(await runtime.run('one', {}), '11:one');
  assert.equal(await runtime.run('two', {}), '12:two');
  assert.equal(run.calls, 12);
  assert.equal(Object.isFrozen(run), false);
  assert.equal(await assemble(runtimeDefinition(execution([], run))).run('three', {}), 'replacement');
});

test('child scope captures resources after ordinary scene input preparation and fixes its declared run receiver', async () => {
  const value = new ResourceOffer({ name: 'test.resolution.value', expose: (source) => source });
  const run = {
    prefix: 'original',
    deps: { value: value.request() },
    execute(work) {
      return `${this.prefix}:${work.input}:${work.resources.value}`;
    },
  };
  const main = execution([], run);
  const definition = runtimeDefinition(main);
  const options = {
    providers: [value.provide((source) => source)],
    source: { capture: () => null },
    bindings: [{ definition: main, capture: (input) => `resource:${input}` }],
  };
  const existing = assemble(definition, options);
  run.prefix = 'live';
  run.deps.value = new ResourceOffer({ name: 'test.resolution.unavailable', expose: (source) => source }).request();
  run.execute = () => assert.fail('mutated original run must not execute');
  assert.throws(() => {
    main.deps = {};
    main.run = (work) => `new:${work.input}`;
  }, TypeError);
  assert.equal(await existing.run('one', {}), 'live:one:resource:one');
  const replacement = execution([], { deps: {}, execute: (work) => `new:${work.input}` });
  assert.equal(await assemble(runtimeDefinition(replacement)).run('two', {}), 'new:two');
});

test('observation declarations are fixed before lazy construction while consumers keep their own state', async () => {
  const observation = {
    deps: {},
    starts: 0,
    observe(fact) {
      if (fact.kind === 'started') this.starts++;
    },
  };
  let replacementStarts = 0;
  const replacement = {
    deps: {},
    observe(fact) {
      if (fact.kind === 'started') replacementStarts++;
    },
  };
  const main = execution([], { deps: {}, execute: (context) => context.input });
  const registered = [observation];
  const definition = runtimeDefinition(main);
  const installation = { declarations: (scope) => (scope === main ? registered : []), bindInvocation: () => ({ observe() {} }) };
  const existing = assemble(definition, { observations: [installation] });
  observation.observe = () => assert.fail('mutated observer must not run');
  observation.deps.unavailable = new ResourceOffer({ name: 'test.resolution.observer', expose: (value) => value }).request();
  registered.splice(0, 1, replacement);
  assert.equal(await existing.run('first', {}), 'first');
  assert.equal(observation.starts, 1);
  assert.equal(replacementStarts, 0);
  const next = execution([], { deps: {}, execute: (work) => work.input });
  assert.equal(await assemble(runtimeDefinition(next), { observations: [{ declarations: (scope) => (scope === next ? [replacement] : []), bindInvocation: () => ({ observe() {} }) }] }).run('second', {}), 'second');
  assert.equal(replacementStarts, 1);
});

test('checkpoint contracts, codecs and continuation callbacks use the same fixed declaration as normal assembly', async () => {
  const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
  const resume = {
    deps: {},
    calls: 0,
    run(_work, state) {
      this.calls++;
      return state.answer;
    },
  };
  const point = { name: 'saved', references: {}, state: codec, check: () => true, resume };
  const checkpoint = { key: 'test.resolution.checkpoint', version: 1, input: codec, output: codec, points: [point] };
  const definition = new Scene({ checkpoint, deps: {}, run: () => assert.fail('normal work cannot replay during restoration') });
  const store = new MemoryCheckpointStore();
  const save = (contextId) => store.save({ id: `image-${contextId}`, formatVersion: 5, contract: { key: checkpoint.key, version: 1 }, point: 'saved', references: {}, frame: { owner: { contextId, kind: 'scene' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] }, state: { answer: 'original continuation' } }, 0);
  save('original-root');
  save('new-root');
  const existing = assemble(definition, { checkpoints: { store } });
  codec.decode = () => assert.fail('mutated codec must not be read');
  codec.encode = () => assert.fail('mutated codec must not be written');
  point.check = () => assert.fail('mutated point check must not run');
  resume.run = () => assert.fail('mutated continuation must not run');
  resume.deps.unavailable = new ResourceOffer({ name: 'test.resolution.checkpoint-missing', expose: (value) => value }).request();
  checkpoint.points[0] = { name: 'saved', references: {}, state: codec, resume: { deps: {}, run: () => 'new continuation' } };
  checkpoint.version = 2;
  assert.equal(await existing.resume('original-root', {}), 'original continuation');
  assert.equal(resume.calls, 1);
  assert.equal(store.read('original-root').delivery.output, 'original continuation');
  const replacement = assemble(new Scene({ checkpoint, run: () => null }), { checkpoints: { store } });
  await assert.rejects(replacement.resume('new-root', {}), /incompatible/);
});

test('a factory observation fixes its callback while retaining the consumer receiver through host installation', async () => {
  const consumer = {
    deps: {},
    prefix: 'first',
    starts: [],
    observe(fact) {
      if (fact.kind === 'started') this.starts.push(`${this.prefix}:${fact.input}`);
    },
  };
  const declaration = defineObservation(consumer, { failure: 'propagate' });
  const main = execution([], { deps: {}, execute: (work) => work.input });
  const installation = { declarations: (scope) => (scope === main ? [declaration] : []), bindInvocation: () => ({ observe() {} }) };
  const existing = assemble(runtimeDefinition(main), { observations: [installation] });
  consumer.observe = () => assert.fail('a replaced consumer method cannot change an already declared callback');
  consumer.prefix = 'live';
  assert.equal(await existing.run('input', {}), 'input');
  assert.deepEqual(consumer.starts, ['live:input']);
});
