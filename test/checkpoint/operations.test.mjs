import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeDefinition, ExecutionDefinition, MemoryCheckpointStore, checkpointPoint, childReference, assembleRuntime } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/server-runtime/content';
import { SelectHistoryDefinition, UnderstandRequestDefinition, DefaultConversationDecisionDefinition, FunctionConversationDecisionDefinition, CheckFileTaskDefinition, ProcessDocumentDefinition, ModelInteractions, ModelSource, ModelResource, ModelSettingsResource } from '@capix/observer-service/conversation';
import { FileResources } from '@capix/observer-service/assembly';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 256, timeoutMs: 1000 };
const answer = { kind: 'answer', content: '固定正文' };
const codec = { encode: structuredClone, decode: structuredClone };
class CapturedStore extends MemoryCheckpointStore {
  writes = [];
  save(image, revision) {
    const head = super.save(image, revision);
    this.writes.push({ image, revision });
    return head;
  }
  finish(id, revision, delivery) {
    const head = super.finish(id, revision, delivery);
    this.writes.push({ id, revision, delivery });
    return head;
  }
}
function restore(writes) {
  const store = new MemoryCheckpointStore();
  for (const write of writes) {
    if (write.image) store.save(write.image, write.revision);
    else store.finish(write.id, write.revision, write.delivery);
  }
  return store;
}
function parentCheckpoint(key, child) {
  return {
    key,
    version: 1,
    input: codec,
    output: codec,
    points: [
      checkpointPoint()({
        name: 'waiting',
        state: codec,
        references: { child: childReference(child) },
        resume: {
          requires: {},
          uses: [child],
          async execute(work, _state, saved) {
            const call = work.children.resume(saved.child);
            await call.run();
            return call.accept();
          },
        },
      }),
    ],
  };
}
function assemble(operation, store, providers) {
  class E extends ExecutionDefinition {
    children = [operation];
    checkpoint = parentCheckpoint('fixture.operations.e', operation);
    run = {
      requires: operation.run.requires,
      execute: async (work) => {
        const call = work.children.create(operation, work.input, { key: 'operation' });
        work.checkpoint.save(this.checkpoint.points[0], {}, { child: call.ref });
        await call.run();
        return call.accept();
      },
    };
  }
  const execution = new E();
  class R extends RuntimeDefinition {
    children = [execution];
    checkpoint = parentCheckpoint('fixture.operations.r', execution);
    run = {
      requires: {},
      execute: async (work) => {
        const call = work.children.create(execution, work.input, { key: 'execution' });
        work.checkpoint.save(this.checkpoint.points[0], {}, { child: call.ref });
        await call.run();
        return call.accept();
      },
    };
  }
  return assembleRuntime(new R(), { checkpoints: { store }, providers, source: { entry: () => null, capture: () => null } });
}
function environment(t, options = {}) {
  const transcript = new Transcript([{ role: 'user', content: '处理文件' }]);
  const counters = { model: 0, reads: 0, inspections: 0 };
  const interactions = new ModelInteractions(
    new ModelSource({
      async invoke(_request, purpose) {
        counters.model++;
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        return { id: 'fixture', model: 'fixture', finishReason: 'stop', usage: null, content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'understanding' ? { kind: 'reply' } : answer) };
      },
    }),
  );
  t.after(() => interactions.close());
  const files = {
    configuration: { maxReadBytes: 1000 },
    async readText(path) {
      counters.reads++;
      return { path, bytes: 4, digest: 'fixed-digest', text: '正文' };
    },
    async checkTask(task) {
      counters.inspections++;
      return { kind: 'ready', task };
    },
  };
  const providers = [ModelSettingsResource.snapshot.provide(() => settings), ModelSettingsResource.timeout.provide(() => options.timeoutMs ?? settings.timeoutMs), TranscriptResource.fixedRange.provide(() => transcript.segments()[0]), ModelResource.create.provide(() => interactions), ModelResource.read.provide(() => interactions), FileResources.readText.provide(() => ({ files, path: 'notes.md' })), FileResources.inspect.provide(() => ({ files }))];
  const selection = { message: transcript.get(0), memories: [] };
  const understanding = { ...selection, selection: { historyIndexes: [] } };
  const decision = {
    request: understanding,
    progress: {},
    available: [
      { name: 'answer', description: '回答', arguments: {} },
      { name: 'checkFile', description: '预检', arguments: {} },
    ],
  };
  return { providers, counters, selection, understanding, decision, interactions };
}

for (const scenario of ['selection', 'understanding', 'decision', 'preflight', 'document', 'function']) {
  test(`${scenario} declaration resumes a fixed child/result without repeating completed model or file work`, async (t) => {
    const env = environment(t);
    const create = () => (scenario === 'selection' ? new SelectHistoryDefinition() : scenario === 'understanding' ? new UnderstandRequestDefinition({ files: true }) : scenario === 'decision' ? new DefaultConversationDecisionDefinition({ files: true }) : scenario === 'preflight' ? new CheckFileTaskDefinition() : scenario === 'document' ? new ProcessDocumentDefinition() : new FunctionConversationDecisionDefinition(() => ({ kind: 'invoke', capability: 'answer', arguments: {} })));
    const input = scenario === 'selection' ? env.selection : scenario === 'understanding' ? env.understanding : scenario === 'decision' || scenario === 'function' ? env.decision : scenario === 'preflight' ? { task: { sourcePath: 'notes.md' }, instruction: '读取' } : { sourcePath: 'notes.md', selection: { historyIndexes: [] }, memories: [] };
    const store = new CapturedStore();
    const expected = await assemble(create(), store, env.providers).run(input, {});
    const count = { ...env.counters };
    const target = scenario === 'preflight' ? 'observer.inspect-file' : scenario === 'function' ? 'observer.function-decision' : 'observer.request-model.' + (scenario === 'selection' ? 'selection' : scenario === 'document' ? 'answer' : 'understanding');
    const boundary = store.writes.findIndex((write) => write.image?.contract.key === target && (write.image.point === 'result' || write.image.point === 'feedbackAccepted'));
    assert.ok(boundary >= 0);
    const runtime = assemble(create(), restore(store.writes.slice(0, boundary + 1)), env.providers);
    assert.deepEqual(await runtime.resume(store.writes[0].image.frame.owner.contextId, {}), expected);
    assert.deepEqual(env.counters, count);
  });
}

test('model interaction reference recovery consumes saved feedback without reissuing the external request', async (t) => {
  const env = environment(t);
  const store = new CapturedStore();
  const expected = await assemble(new SelectHistoryDefinition(), store, env.providers).run(env.selection, {});
  const boundary = store.writes.findIndex((write) => write.image?.point === 'interactionStarted');
  const restored = assemble(new SelectHistoryDefinition(), restore(store.writes.slice(0, boundary + 1)), env.providers);
  assert.deepEqual(await restored.resume(store.writes[0].image.frame.owner.contextId, {}), expected);
  assert.equal(env.counters.model, 1);
});

test('unknown file read is not repeated when its result has no durable checkpoint', async (t) => {
  const env = environment(t);
  const store = new CapturedStore();
  const create = () => new ProcessDocumentDefinition();
  await assemble(create(), store, env.providers).run({ sourcePath: 'notes.md', selection: { historyIndexes: [] }, memories: [] }, {});
  const boundary = store.writes.findIndex((write) => write.image?.point === 'reading');
  const restored = assemble(create(), restore(store.writes.slice(0, boundary + 1)), env.providers);
  await assert.rejects(restored.resume(store.writes[0].image.frame.owner.contextId, {}), /no durable continuation/);
  assert.equal(env.counters.reads, 1);
});

for (const stage of ['preparation', 'acceptance']) {
  for (const kind of ['selection', 'understanding']) {
    test(`${kind} resumes its ${stage} A result before the parent has accepted it`, async (t) => {
      const env = environment(t);
      const create = () => (kind === 'selection' ? new SelectHistoryDefinition() : new UnderstandRequestDefinition({ files: true }));
      const input = kind === 'selection' ? env.selection : env.understanding;
      const store = new CapturedStore();
      const expected = await assemble(create(), store, env.providers).run(input, {});
      const key = stage === 'preparation' ? 'observer.prepare-model-request' : 'observer.accept-model-output';
      const boundary = store.writes.findIndex((write) => write.image?.contract.key === key && write.image.point === 'result');
      const restoredEnv = stage === 'preparation' ? environment(t) : env;
      const before = restoredEnv.counters.model;
      const restored = assemble(create(), restore(store.writes.slice(0, boundary + 1)), restoredEnv.providers);
      assert.deepEqual(await restored.resume(store.writes[0].image.frame.owner.contextId, {}), expected);
      assert.equal(restoredEnv.counters.model, before + (stage === 'preparation' ? 1 : 0));
    });
  }
}
for (const kind of ['selection', 'understanding']) {
  test(`${kind} recognizes restored message value in a fixed history range and rejects different input`, async (t) => {
    const env = environment(t);
    const create = () => (kind === 'selection' ? new SelectHistoryDefinition() : new UnderstandRequestDefinition({ files: true }));
    const input = structuredClone(kind === 'selection' ? env.selection : env.understanding);
    await assemble(create(), new CapturedStore(), env.providers).run(input, {});
    assert.equal(env.counters.model, 1);
    await assert.rejects(assemble(create(), new CapturedStore(), env.providers).run({ ...input, message: { role: 'user', content: '不同输入' } }, {}), /final message/);
    assert.equal(env.counters.model, 1);
  });
}

test('missing model interaction feedback cannot be replaced by another model request', async (t) => {
  const env = environment(t);
  const store = new CapturedStore();
  await assemble(new SelectHistoryDefinition(), store, env.providers).run(env.selection, {});
  const boundary = store.writes.findIndex((write) => write.image?.point === 'interactionStarted');
  const restoredEnv = environment(t);
  const restored = assemble(new SelectHistoryDefinition(), restore(store.writes.slice(0, boundary + 1)), restoredEnv.providers);
  await assert.rejects(restored.resume(store.writes[0].image.frame.owner.contextId, {}), { code: 'MODEL_INTERACTION_UNKNOWN' });
  assert.equal(restoredEnv.counters.model, 0);
});

for (const mismatch of ['request', 'purpose']) {
  test(`interaction recovery rejects an existing unrelated ${mismatch} without consuming its feedback`, async (t) => {
    const env = environment(t);
    const store = new CapturedStore();
    await assemble(new SelectHistoryDefinition(), store, env.providers).run(env.selection, {});
    const boundary = store.writes.findIndex((write) => write.image?.point === 'interactionStarted');
    const saved = store.writes[boundary].image;
    const request = mismatch === 'request' ? { ...saved.frame.currentInput, model: 'different-model' } : saved.frame.currentInput;
    const purpose = mismatch === 'purpose' ? 'answer' : 'selection';
    const unrelated = env.interactions.start(request, purpose, { signal: new AbortController().signal, timeoutMs: 1000 });
    await env.interactions.result(unrelated, { signal: new AbortController().signal });
    const writes = structuredClone(store.writes.slice(0, boundary + 1));
    writes[boundary].image.state = unrelated;
    const resumed = assemble(new SelectHistoryDefinition(), restore(writes), env.providers);
    await assert.rejects(resumed.resume(writes[0].image.frame.owner.contextId, {}), { code: 'MODEL_INTERACTION_MISMATCH' });
    assert.equal(env.counters.model, 2);
  });
}

test('a saved follow A waits for the original interaction instead of recreating start A', async (t) => {
  const env = environment(t, { timeoutMs: 200, delayMs: 120 });
  const store = new CapturedStore();
  const expected = await assemble(new SelectHistoryDefinition(), store, env.providers).run(env.selection, {});
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'observer.follow-model' && write.image.point === 'waiting');
  assert.ok(boundary > 0, 'the first local wait delivered pending and established a follow call');
  const resumed = assemble(new SelectHistoryDefinition(), restore(store.writes.slice(0, boundary + 1)), env.providers);
  assert.deepEqual(await resumed.resume(store.writes[0].image.frame.owner.contextId, {}), expected);
  assert.equal(env.counters.model, 1);
});
