import { runtimeDefinition } from './fixtures/declarations.mjs';
import { captureSource, resourceBindingFor } from './fixtures/observer.mjs';
import { createEnvironment } from './fixtures/environment.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Initializer, ResourceOffer, bindResources, TranscriptResource, MemoryResource, assembleRuntime, OperationDefinition, ExecutionDefinition, AttemptRecord, OperationRecord } from '@capix/server-runtime';
import { initializeObserver, ModelSettingsResource } from '@capix/observer-service';

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
function run(env, configuration = settings) {
  return env.runtime.run({ messages: [{ role: 'user', content: '你好' }] }, { settings: configuration });
}
const attempts = (env) => [...env.book.values()].filter((record) => record instanceof AttemptRecord);
const operations = (env) => [...env.book.values()].filter((record) => record instanceof OperationRecord);

test('unused operations and model providers stay inactive; bound O identities survive later calls', async () => {
  let fail = true;
  const env = environment(async (_request, purpose) => {
    if (fail) throw new Error('model unavailable');
    return raw(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? answer : { memories: [] });
  });
  assert.equal(env.modelCreations(), 0);
  assert.deepEqual(operations(env), []);
  await assert.rejects(run(env), /model unavailable/);
  const first = operations(env);
  assert.deepEqual(
    first.map((operation) => operation.operation),
    ['selection', 'requestModel'],
  );
  assert.equal(first[1].parentId, first[0].id);
  assert.equal(
    attempts(env).some((record) => record.name === 'acceptModelOutput'),
    false,
  );
  fail = false;
  await run(env);
  const selection = operations(env).filter((record) => record.operation === 'selection');
  assert.equal(selection.length, 2);
  assert.equal(selection[0].operationInstanceId, selection[1].operationInstanceId);
  assert.equal(env.modelCreations(), 1);
  assert.equal(env.transcript.current('assistant').content, answer.content);
});

test('capacity rejection does not invoke later actions or instantiate a model provider', async () => {
  const env = environment(() => assert.fail('must not invoke'));
  await assert.rejects(run(env, { ...settings, contextBudget: 256, maxOutputTokens: 64 }), (error) => error.code === 'CAPACITY_EXCEEDED');
  assert.equal(env.modelCreations(), 0);
  assert.equal(operations(env).length, 1);
  assert.equal(
    attempts(env).some((record) => record.name === 'invokeModel'),
    false,
  );
});

test('regeneration adds calls only on the explicitly declared second-pass branch', async () => {
  let invalid = false;
  let calls = 0;
  const env = environment(async (_request, purpose) => {
    if (purpose === 'answer') calls++;
    if (purpose === 'answer' && invalid) {
      invalid = false;
      return raw({ kind: 'unsupported', content: 'invalid' });
    }
    return raw(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? answer : { memories: [] });
  });
  await run(env);
  assert.equal(calls, 1);
  invalid = true;
  await run(env);
  assert.equal(calls, 3);
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

test('declarations are checked before resource access or invocation construction', () => {
  const resource = new ResourceOffer('test.dependency', (value) => value);
  class Work extends OperationDefinition {
    name = 'test';
    label = 'test';
    source = 'test';
    run = { requires: { value: resource.request() }, execute: this.execute.bind(this) };
    execute() {
      assert.fail('must not execute');
    }
  }
  class Root extends ExecutionDefinition {
    run = { requires: {}, execute: this.execute.bind(this) };
    children = [new Work()];
    execute() {
      assert.fail('must not execute');
    }
  }
  let supplied = 0;
  assert.throws(
    () =>
      assembleRuntime(runtimeDefinition(new Root()), {
        providers: [
          resource.provide(() => {
            supplied++;
            return 'value';
          }),
        ],
        source: { entry: () => null, capture: () => null },
      }),
    /not provided/,
  );
  assert.equal(supplied, 0);
});

test('lazy resource supplies share capture including failure, while access endpoints are local', () => {
  let created = 0;
  const resource = new ResourceOffer('test.lazy', (captured) => captured, 'access', {
    capture: (source) => {
      created++;
      return Object.freeze({ source });
    },
  });
  const bind = bindResources({ resource: resource.request() }, [resource.provide((source) => source)]);
  const parent = bind('first');
  const child = parent.select({ alias: resource.request() });
  assert.equal(created, 0);
  assert.deepEqual(Object.keys(parent.values), ['resource']);
  assert.equal(child.values.alias, parent.values.resource);
  assert.equal(created, 1);
  assert.notEqual(bind('second').values.resource, child.values.alias);
  assert.equal(created, 2);
  let failed = 0;
  const failure = new Error('source unavailable');
  const broken = new ResourceOffer('test.failed', (source) => source);
  const pending = bindResources({ one: broken.request() }, [
    broken.provide(() => {
      failed++;
      throw failure;
    }),
  ])(null);
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

test('lazy access never shifts the capture point of configuration, history or memory snapshots', async () => {
  const { runtime, transcript, memories } = createEnvironment({ messages: [{ role: 'user', content: '培训周五' }] });
  const change = { action: 'create', memoryId: null, change: '确认时间', sourceIndexes: [0], result: { topic: '培训', content: '周五', sourceIndexes: [0] } };
  const memory = memories.apply([change])[0];
  const resources = resourceBindingFor(runtime, { invoke: () => assert.fail('unused') }, { transcript, memories });
  const configuration = { ...settings };
  const root = runtime.executionInvocationBuilder.create(null, {
    context: {},
    requires: { settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request(), memories: MemoryResource.snapshot.request() },
    establish: () => ({ resources: resources(captureSource({ settings: configuration, transcript })) }),
    work: {
      maxRounds: 1,
      execute: (context) => {
        assert.equal(context.resources.values.settings.model, 'fixture');
        assert.equal(context.resources.values.history.end, 1);
        assert.equal(context.resources.values.memories[0].content, '周五');
        return null;
      },
    },
  });
  configuration.model = 'later';
  transcript.append({ role: 'assistant', content: 'later' });
  memories.apply([{ ...change, action: 'update', memoryId: memory.id, result: { ...change.result, content: '周六' } }]);
  await root.run();
});
