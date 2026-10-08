import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Initializer, BehaviorInitializer, ResourceOffer, bindResources, checkResourceRequests, Sequence, TranscriptResource, MemoryResource, createRuntime, Operation } from '@capix-observer/runtime';
import { initializeObserver, acceptExecutionInput, ObserverResourceInitializer, ModelSettingsResource } from '@capix-observer/service';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const raw = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const answer = { kind: 'answer', content: '完成' };

function environment(invoke) {
  let created = 0;
  const value = initializeObserver(() => {
    created++;
    return { invoke };
  });
  return { ...value, modelCreations: () => created };
}
function run(environment, configuration = settings) {
  return environment.execution.submit(() => acceptExecutionInput(environment.transcript, { messages: [{ role: 'user', content: '你好' }] }), { settings: configuration });
}

test('unused operations and model providers stay uninitialized; used instances survive later calls', async () => {
  let fail = true;
  const env = environment(async (_request, purpose) => {
    if (fail) throw new Error('model unavailable');
    return raw(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? answer : { memories: [] });
  });
  const init = env.initialization;
  assert.equal(init.execution.get(), env.execution);
  assert.equal(env.modelCreations(), 0);
  assert.ok([init.selection, init.generation, init.extraction].every((item) => !item.initialized));
  assert.equal([...env.book.values()].length, 1);
  await assert.rejects(run(env), /model unavailable/);
  assert.equal(init.selection.initialized, true);
  assert.equal(init.generation.initialized, false);
  assert.equal(init.extraction.initialized, false);
  const selection = init.selection.get();
  assert.equal(selection.prepareRequest.initialized, true);
  assert.equal(selection.invokeModel.initialized, true);
  assert.equal(selection.acceptOutput.initialized, false);
  fail = false;
  await run(env);
  assert.equal(init.selection.get(), selection);
  assert.equal(env.modelCreations(), 1);
  assert.equal(init.generation.get().prepareRegeneration.initialized, false);
  assert.equal(init.extraction.get().applyMemory.initialized, true);
  assert.equal(env.transcript.current('assistant').content, answer.content);
});

test('capacity preparation and early rejection do not build later actions or a model provider', async () => {
  const env = environment(() => assert.fail('must not invoke'));
  await assert.rejects(run(env, { ...settings, contextBudget: 1 }), (error) => error.code === 'CAPACITY_EXCEEDED');
  const selection = env.initialization.selection.get();
  assert.equal(selection.prepareRequest.initialized, true);
  assert.equal(selection.invokeModel.initialized, false);
  assert.equal(selection.acceptOutput.initialized, false);
  assert.equal(env.modelCreations(), 0);
  assert.equal(env.initialization.generation.initialized, false);
});

test('regeneration preparation is initialized only on the declared second-pass branch', async () => {
  let invalid = false;
  const env = environment(async (_request, purpose) => {
    if (purpose === 'answer' && invalid) {
      invalid = false;
      return raw({ kind: 'unsupported', content: 'invalid' });
    }
    return raw(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? answer : { memories: [] });
  });
  await run(env);
  const generation = env.initialization.generation.get();
  const model = generation.invokeModel.get();
  assert.equal(generation.prepareRegeneration.initialized, false);
  invalid = true;
  await run(env);
  assert.equal(generation.prepareRegeneration.initialized, true);
  assert.equal(generation.invokeModel.get(), model);
  assert.equal(env.modelCreations(), 1);
});

test('an initializer retains failure and rejects recursive creation without implicit retries', () => {
  const failure = new Error('initialization failed');
  let attempts = 0;
  const value = new Initializer(() => {
    attempts++;
    throw failure;
  });
  assert.equal(value.initialized, false);
  for (let index = 0; index < 2; index++)
    assert.throws(
      () => value.get(),
      (error) => error === failure,
    );
  assert.equal(attempts, 1);
  assert.equal(value.initialized, false);
  const recursive = new Initializer(() => recursive.get());
  assert.throws(() => recursive.get(), /Recursive initialization/);
});

test('declarations are checked without construction, and factory mismatches cannot attach a child', () => {
  const runtime = createRuntime();
  const resource = new ResourceOffer('test.dependency', (value) => value);
  let created = 0;
  class Work extends Operation {
    name = 'test';
    label = 'test';
    source = 'test';
    requires = { value: resource.request() };
    execute() {
      assert.fail('must not execute');
    }
  }
  const declared = new BehaviorInitializer({ value: resource.request() }, () => {
    created++;
    return new Work(runtime.operationInvocations);
  });
  const sequence = new Sequence().step('work', { use: declared, input: () => null });
  assert.throws(() => checkResourceRequests({}, sequence.requests), /not provided/);
  assert.equal(created, 0);
  const mismatch = new BehaviorInitializer({}, () => {
    created++;
    return new Work(runtime.operationInvocations);
  });
  const root = runtime.executionInvocations.create(null, { context: { settings }, work: { maxRounds: 1, execute: () => null } });
  assert.throws(() => mismatch.create(root, null), /not provided/);
  assert.throws(() => mismatch.create(root, null), /not provided/);
  assert.equal(created, 1);
  assert.equal(root.children.values().length, 0);
});

test('lazy resource values are shared down the declared branch, including initialization failure', () => {
  let created = 0;
  const resource = new ResourceOffer('test.lazy', (source) => {
    created++;
    return Object.freeze({ source });
  });
  const bind = bindResources({ resource: resource.request() }, [resource.provide((source) => source)]);
  const parent = bind('first');
  const child = parent.select({ alias: resource.request() });
  assert.equal(created, 0);
  assert.deepEqual(Object.keys(parent.values), ['resource']);
  assert.equal(created, 0);
  assert.equal(child.values.alias, parent.values.resource);
  assert.equal(created, 1);
  assert.notEqual(bind('second').values.resource, child.values.alias);
  assert.equal(created, 2);
  let failed = 0;
  const failure = new Error('source unavailable');
  const broken = new ResourceOffer('test.failed', () => {
    failed++;
    throw failure;
  });
  const pending = bindResources({ one: broken.request() }, [broken.provide(() => null)])(null);
  const narrower = pending.select({ two: broken.request() });
  assert.throws(
    () => pending.values.one,
    (error) => error === failure,
  );
  assert.throws(
    () => narrower.values.two,
    (error) => error === failure,
  );
  assert.equal(failed, 1);
});

test('lazy access never shifts the capture point of configuration, history or memory snapshots', () => {
  const runtime = createRuntime({ messages: [{ role: 'user', content: '培训周五' }] });
  const { transcript, memories } = runtime.context;
  const change = { action: 'create', memoryId: null, change: '确认时间', sourceIndexes: [0], result: { topic: '培训', content: '周五', sourceIndexes: [0] } };
  const memory = memories.apply([change])[0];
  let models = 0;
  const resource = new ObserverResourceInitializer(runtime.context, () => {
    models++;
    return { invoke: () => assert.fail('unused') };
  });
  const configuration = { ...settings };
  const root = runtime.executionInvocations.create(null, {
    context: { settings: configuration },
    requires: { settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request(), memories: MemoryResource.snapshot.request() },
    resourceBinding: resource.execution,
    work: { maxRounds: 1, execute: () => null },
  });
  configuration.model = 'later';
  transcript.append({ role: 'assistant', content: 'later' });
  memories.apply([{ ...change, action: 'update', memoryId: memory.id, result: { ...change.result, content: '周六' } }]);
  const values = root.context.resources.values;
  assert.equal(values.settings.model, 'fixture');
  assert.equal(values.history.end, 1);
  assert.equal(values.memories[0].content, '周五');
  assert.equal(models, 0);
});
