import { installCallable } from './fixtures/driver.mjs';
import { runtimeDefinition } from './fixtures/declarations.mjs';
import { captureSource } from './fixtures/observer.mjs';
import { createEnvironment } from './fixtures/environment.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Initializer, ResourceOffer, bindResources, TranscriptResource, MemoryResource, Group, CallableRecord } from '@capix/server-runtime';
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
  return env.driver.run(env.scene, { messages: [{ role: 'user', content: '你好' }] }, { settings: configuration });
}
const attempts = (env) => [...env.book.values()].filter((record) => record instanceof CallableRecord && record.structureKind === 'node');
const operations = (env) => [...env.book.values()].filter((record) => record instanceof CallableRecord && record.structureKind === 'group' && record.role !== 'conversation-task');

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
    first.map((operation) => operation.name),
    ['prepareContext', 'conversationDecision', 'answer', 'requestModel'],
  );
  assert.equal(first[3].parentId, first[2].id);
  assert.equal(
    attempts(env).some((record) => record.name === 'acceptModelOutput'),
    false,
  );
  fail = false;
  await run(env);
  const answers = operations(env).filter((record) => record.name === 'answer');
  assert.equal(answers.length, 2);
  assert.equal(typeof answers[0].structureId, 'string');
  assert.equal(answers[0].structureId, answers[1].structureId);
  assert.equal(env.modelCreations(), 1);
  assert.equal(env.transcript.current('assistant').content, answer.content);
});

test('capacity rejection does not invoke later actions or instantiate a model provider', async () => {
  const env = environment(() => assert.fail('must not invoke'));
  await assert.rejects(run(env, { ...settings, contextBudget: 256, maxOutputTokens: 64 }), (error) => error.code === 'CAPACITY_EXCEEDED');
  assert.equal(env.modelCreations(), 0);
  assert.deepEqual(
    operations(env).map((operation) => operation.name),
    ['prepareContext', 'conversationDecision', 'answer'],
  );
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
  const unrelated = new ResourceOffer('test.unrelated', (value) => value);
  class Work extends Group {
    name = 'test';
    label = 'test';
    source = 'test';
    run = { requires: { value: resource.request() }, execute: this.execute.bind(this) };
    execute() {
      assert.fail('must not execute');
    }
  }
  class Root extends Group {
    run = { requires: {}, execute: this.execute.bind(this) };
    members = [new Work()];
    execute() {
      assert.fail('must not execute');
    }
  }
  let supplied = 0;
  assert.throws(
    () =>
      installCallable(runtimeDefinition(new Root()), {
        providers: [
          unrelated.provide(() => {
            supplied++;
            return 'value';
          }),
        ],
        source: { capture: () => null },
      }),
    /Expected one resource provider/,
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
  const requires = { settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request(), memories: MemoryResource.snapshot.request() };
  const resources = bindResources(requires, [ModelSettingsResource.snapshot.provide((source) => source.settings), TranscriptResource.fixedRange.provide((source) => source.transcriptRange), MemoryResource.snapshot.provide(() => memories)]);
  const configuration = { ...settings };
  const root = runtime.executionInvocationBuilder.create(null, {
    context: {},
    requires,
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
