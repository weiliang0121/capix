import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutionDefinition, ResourceOffer, MemoryCheckpointStore, assembleRuntime } from '@capix/server-runtime';
import { runtimeDefinition } from './fixtures/declarations.mjs';

function attempt(name, run) {
  return { level: 'attempt', name, label: name, source: 'test', callee: 'test', maxRounds: 1, raises: [], run };
}

function operation(name, children, run) {
  return { level: 'operation', name, label: name, source: 'test', children, maxRounds: 1, raises: [], run };
}

function execution(children, run) {
  return { level: 'execution', children, maxRounds: 1, raises: [], run };
}

function assemble(definition, options = {}) {
  return assembleRuntime(definition, { providers: [], source: { capture: () => null }, ...options });
}

test('declaration checks finish once per binding position before any call and never repeat during lazy construction', async () => {
  const checked = [];
  const called = [];
  const leaf = attempt('leaf', { requires: {}, execute: (context) => context.input });
  const shared = operation('shared', [leaf], { requires: {}, execute: (context) => context.children.create(leaf, context.input).run() });
  const parent = (name) => operation(name, [shared], { requires: {}, execute: (context) => context.children.create(shared, context.input).run() });
  const left = parent('left');
  const right = parent('right');
  const main = execution([left, right], { requires: {}, execute: (context) => context.children.create(context.input === 'right' ? right : left, context.input).run() });
  const definition = runtimeDefinition(main);
  const runtime = assemble(definition, {
    observations: [
      {
        check(scope, owner) {
          checked.push([scope.level, scope.name, owner?.level, owner?.name]);
        },
        bindInvocation(setup) {
          called.push({ ...setup.identity, description: setup.description });
          return { observe() {} };
        },
      },
    ],
  });
  assert.deepEqual(checked, [
    ['runtime', undefined, undefined, undefined],
    ['execution', undefined, 'runtime', undefined],
    ['operation', 'left', 'execution', undefined],
    ['operation', 'shared', 'operation', 'left'],
    ['attempt', 'leaf', 'operation', 'shared'],
    ['operation', 'right', 'execution', undefined],
    ['operation', 'shared', 'operation', 'right'],
    ['attempt', 'leaf', 'operation', 'shared'],
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

test('a shared child keeps its supply at each parent position without granting it to the parent', async () => {
  const value = new ResourceOffer('test.resolution.parent-scope', (source) => source, 'binding');
  const requires = { value: value.request() };
  let captures = 0;
  const shared = attempt('shared', { requires, execute: (work) => work.resources.value });
  const parent = (name) =>
    operation(name, [shared], {
      requires: {},
      execute(work) {
        assert.deepEqual(Object.keys(work.resources), []);
        return work.children.create(shared, work.input).run();
      },
    });
  const left = parent('left');
  const right = parent('right');
  const main = execution([left, right], { requires: {}, execute: (work) => Promise.all([work.children.create(left, null).run(), work.children.create(right, null).run()]) });
  const runtime = assemble(runtimeDefinition(main), { providers: [value.provide(() => ++captures)] });
  assert.equal(captures, 0);
  assert.deepEqual(await runtime.run(null, {}), [1, 1]);
  assert.equal(captures, 1);
  assert.throws(() => assemble(runtimeDefinition(main)), /Expected one resource provider/);
});

test('resolved children, resource aliases and work functions stay fixed while declaration instances remain live', async () => {
  const oldResource = new ResourceOffer('test.resolution.original', (value) => value);
  const newResource = new ResourceOffer('test.resolution.replacement', (value) => value);
  const originalRequires = { value: oldResource.request() };
  const replacementRequires = { replacement: newResource.request() };
  const originalLeaf = attempt('original-leaf', { requires: originalRequires, execute: (context) => `${context.input}:${context.resources.value}` });
  const originalOperation = operation('original-operation', [originalLeaf], { requires: originalRequires, uses: [originalLeaf], execute: (context) => context.children.create(originalLeaf, context.input).run() });
  const replacementLeaf = attempt('replacement-leaf', { requires: replacementRequires, execute: (context) => `${context.input}:${context.resources.replacement}` });
  const replacementOperation = operation('replacement-operation', [replacementLeaf], { requires: replacementRequires, uses: [replacementLeaf], execute: (context) => context.children.create(replacementLeaf, context.input).run() });
  class Main extends ExecutionDefinition {
    #prefix = 'initial';
    children = [originalOperation];
    run = { requires: originalRequires, uses: [originalOperation], execute: this.execute.bind(this) };
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
  main.children.splice(0, 1, replacementOperation);
  main.run.uses.splice(0, 1, replacementOperation);
  main.run.requires = replacementRequires;
  main.run.execute = (context) => context.children.create(replacementOperation, `replacement:${context.input}`).run();
  originalRequires.value = newResource.request();
  originalOperation.children.length = 0;
  originalOperation.run.uses.length = 0;
  originalOperation.run.execute = () => assert.fail('mutated lazy O work must not run');
  originalLeaf.run.execute = () => assert.fail('mutated lazy A work must not run');
  assert.equal(await existing.run('first', {}), 'live:first:old');
  assert.equal(await existing.run('second', {}), 'live:second:old');
  assert.equal(captured, 2);
  assert.equal(Object.isFrozen(main), false);
  assert.equal(await assemble(definition, options).run('third', {}), 'replacement:third:new');
});

test('fixed run callbacks keep their original receiver without freezing its business state', async () => {
  const run = {
    calls: 0,
    requires: {},
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
  assert.equal(await assemble(definition).run('three', {}), 'replacement');
});

test('E captures resources after ordinary R input preparation and fixes its declared run receiver', async () => {
  const value = new ResourceOffer('test.resolution.value', (source) => source);
  const run = {
    prefix: 'original',
    requires: { value: value.request() },
    execute(work) {
      return `${this.prefix}:${work.input}:${work.resources.value}`;
    },
  };
  const main = execution([], run);
  const definition = runtimeDefinition(main);
  const options = {
    providers: [value.provide((source) => source)],
    source: {
      capture(input, _options, declared) {
        assert.equal(declared, main);
        return `resource:${input}`;
      },
    },
  };
  const existing = assemble(definition, options);
  run.prefix = 'live';
  run.requires.value = new ResourceOffer('test.resolution.unavailable', (source) => source).request();
  run.execute = () => assert.fail('mutated original run must not execute');
  main.run = { requires: {}, execute: (work) => `new:${work.input}` };
  assert.equal(await existing.run('one', {}), 'live:one:resource:one');
  assert.equal(await assemble(definition, options).run('two', {}), 'new:two');
});

test('observation declarations are fixed before lazy construction while consumers keep their own state', async () => {
  const observation = {
    requires: {},
    starts: 0,
    observe(fact) {
      if (fact.kind === 'started') this.starts++;
    },
  };
  let replacementStarts = 0;
  const replacement = {
    requires: {},
    observe(fact) {
      if (fact.kind === 'started') replacementStarts++;
    },
  };
  const main = execution([], { requires: {}, execute: (context) => context.input });
  main.observation = [observation];
  const definition = runtimeDefinition(main);
  const existing = assemble(definition, { observations: [] });
  observation.observe = () => assert.fail('mutated observer must not run');
  observation.requires.unavailable = new ResourceOffer('test.resolution.observer', (value) => value).request();
  main.observation.splice(0, 1, replacement);
  assert.equal(await existing.run('first', {}), 'first');
  assert.equal(observation.starts, 1);
  assert.equal(replacementStarts, 0);
  assert.equal(await assemble(definition, { observations: [] }).run('second', {}), 'second');
  assert.equal(replacementStarts, 1);
});

test('checkpoint contracts, codecs and continuation callbacks use the same fixed declaration as normal assembly', async () => {
  const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
  const resume = {
    requires: {},
    calls: 0,
    execute(_work, state) {
      this.calls++;
      return state.answer;
    },
  };
  const point = { name: 'saved', references: {}, state: codec, check: () => true, resume };
  const checkpoint = { key: 'test.resolution.checkpoint', version: 1, input: codec, output: codec, points: [point] };
  const definition = { level: 'runtime', maxRounds: 1, raises: [], children: [], checkpoint, run: { requires: {}, execute: () => assert.fail('normal work cannot replay during restoration') } };
  const store = new MemoryCheckpointStore();
  const save = (contextId) => store.save({ id: `image-${contextId}`, formatVersion: 2, contract: { key: checkpoint.key, version: 1 }, point: 'saved', references: {}, frame: { owner: { contextId, level: 'runtime' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] }, state: { answer: 'original continuation' } }, 0);
  save('original-root');
  save('new-root');
  const existing = assemble(definition, { checkpoints: { store } });
  codec.decode = () => assert.fail('mutated codec must not be read');
  codec.encode = () => assert.fail('mutated codec must not be written');
  point.check = () => assert.fail('mutated point check must not run');
  resume.execute = () => assert.fail('mutated continuation must not run');
  resume.requires.unavailable = new ResourceOffer('test.resolution.checkpoint-missing', (value) => value).request();
  checkpoint.points[0] = { name: 'saved', references: {}, state: codec, resume: { requires: {}, execute: () => 'new continuation' } };
  checkpoint.version = 2;
  assert.equal(await existing.resume('original-root', {}), 'original continuation');
  assert.equal(resume.calls, 1);
  assert.equal(store.read('original-root').delivery.output, 'original continuation');
  const replacement = assemble(definition, { checkpoints: { store } });
  await assert.rejects(replacement.resume('new-root', {}), /incompatible/);
});
