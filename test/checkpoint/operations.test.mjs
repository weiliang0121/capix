import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, MemoryCheckpointStore, checkpointPoint, childReference } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/server-runtime/content';
import { SelectHistory, UnderstandRequest, DefaultConversationDecision, FunctionConversationDecision, CheckFileTask, ProcessDocument, ModelInteractions, ModelSource, ModelResource, ModelSettingsResource } from '@capix/observer-service/conversation';
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
          deps: {},
          uses: [child],
          async run(work, _state, saved) {
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
  class E extends Group {
    constructor() {
      super();
      this.add(operation);
    }
    checkpoint = parentCheckpoint('fixture.operations.e', operation);
    deps = operation.deps;
    run = async (work) => {
      const call = work.children.create(operation, work.input, { key: 'operation' });
      work.checkpoint({ point: this.checkpoint.points[0], state: {}, refs: { child: call.ref } });
      await call.run();
      return call.accept();
    };
  }
  const execution = new E();
  class R extends Scene {
    constructor() {
      super();
      this.add(execution);
    }
    checkpoint = parentCheckpoint('fixture.operations.r', execution);
    deps = {};
    run = async (work) => {
      const call = work.children.create(execution, work.input, { key: 'execution' });
      work.checkpoint({ point: this.checkpoint.points[0], state: {}, refs: { child: call.ref } });
      await call.run();
      return call.accept();
    };
  }
  return installCallable(new R(), { checkpoints: { store }, providers, source: { capture: () => null } });
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
  const understanding = { ...selection, history: [] };
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
    const create = () => (scenario === 'selection' ? new SelectHistory() : scenario === 'understanding' ? new UnderstandRequest({ files: true }) : scenario === 'decision' ? new DefaultConversationDecision({ files: true }) : scenario === 'preflight' ? new CheckFileTask() : scenario === 'document' ? new ProcessDocument() : new FunctionConversationDecision(() => ({ kind: 'invoke', capability: 'answer', arguments: {} })));
    const input = scenario === 'selection' ? env.selection : scenario === 'understanding' ? env.understanding : scenario === 'decision' || scenario === 'function' ? env.decision : scenario === 'preflight' ? { task: { sourcePath: 'notes.md' }, instruction: '读取' } : { sourcePath: 'notes.md', context: { message: env.selection.message, selectedMessages: [] }, memories: [] };
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
  const expected = await assemble(new SelectHistory(), store, env.providers).run(env.selection, {});
  const boundary = store.writes.findIndex((write) => write.image?.point === 'interactionStarted');
  const restored = assemble(new SelectHistory(), restore(store.writes.slice(0, boundary + 1)), env.providers);
  assert.deepEqual(await restored.resume(store.writes[0].image.frame.owner.contextId, {}), expected);
  assert.equal(env.counters.model, 1);
});

test('unknown file read is not repeated when its result has no durable checkpoint', async (t) => {
  const env = environment(t);
  const store = new CapturedStore();
  const create = () => new ProcessDocument();
  await assemble(create(), store, env.providers).run({ sourcePath: 'notes.md', context: { message: env.selection.message, selectedMessages: [] }, memories: [] }, {});
  const boundary = store.writes.findIndex((write) => write.image?.point === 'reading');
  const restored = assemble(create(), restore(store.writes.slice(0, boundary + 1)), env.providers);
  await assert.rejects(restored.resume(store.writes[0].image.frame.owner.contextId, {}), /no durable continuation/);
  assert.equal(env.counters.reads, 1);
});

for (const stage of ['preparation', 'acceptance']) {
  for (const kind of ['selection', 'understanding']) {
    test(`${kind} resumes its ${stage} A result before the parent has accepted it`, async (t) => {
      const env = environment(t);
      const create = () => (kind === 'selection' ? new SelectHistory() : new UnderstandRequest({ files: true }));
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
test('the optional selection operation still verifies its message against the fixed Transcript range', async (t) => {
  const env = environment(t);
  const input = structuredClone(env.selection);
  await assemble(new SelectHistory(), new CapturedStore(), env.providers).run(input, {});
  assert.equal(env.counters.model, 1);
  await assert.rejects(assemble(new SelectHistory(), new CapturedStore(), env.providers).run({ ...input, message: { role: 'user', content: '不同输入' } }, {}), /final message/);
  assert.equal(env.counters.model, 1);
});

test('understanding consumes its fixed input without comparing it to current Transcript content', async (t) => {
  const env = environment(t);
  const input = { ...structuredClone(env.understanding), message: { role: 'user', content: '已经固定的旧输入' }, history: [{ index: 42, message: { role: 'assistant', content: '已经固定的旧材料' } }] };
  assert.deepEqual(await assemble(new UnderstandRequest({ files: true }), new CapturedStore(), env.providers).run(input, {}), { kind: 'reply' });
  assert.equal(env.counters.model, 1);
});

test('missing model interaction feedback cannot be replaced by another model request', async (t) => {
  const env = environment(t);
  const store = new CapturedStore();
  await assemble(new SelectHistory(), store, env.providers).run(env.selection, {});
  const boundary = store.writes.findIndex((write) => write.image?.point === 'interactionStarted');
  const restoredEnv = environment(t);
  const restored = assemble(new SelectHistory(), restore(store.writes.slice(0, boundary + 1)), restoredEnv.providers);
  await assert.rejects(restored.resume(store.writes[0].image.frame.owner.contextId, {}), { code: 'MODEL_INTERACTION_UNKNOWN' });
  assert.equal(restoredEnv.counters.model, 0);
});

for (const mismatch of ['request', 'purpose']) {
  test(`interaction recovery rejects an existing unrelated ${mismatch} without consuming its feedback`, async (t) => {
    const env = environment(t);
    const store = new CapturedStore();
    await assemble(new SelectHistory(), store, env.providers).run(env.selection, {});
    const boundary = store.writes.findIndex((write) => write.image?.point === 'interactionStarted');
    const saved = store.writes[boundary].image;
    const request = mismatch === 'request' ? { ...saved.frame.currentInput, model: 'different-model' } : saved.frame.currentInput;
    const purpose = mismatch === 'purpose' ? 'answer' : 'selection';
    const unrelated = env.interactions.start(request, purpose, { timeoutMs: 1000 });
    await env.interactions.result(unrelated, { signal: new AbortController().signal });
    const writes = structuredClone(store.writes.slice(0, boundary + 1));
    writes[boundary].image.state = unrelated;
    const resumed = assemble(new SelectHistory(), restore(writes), env.providers);
    await assert.rejects(resumed.resume(writes[0].image.frame.owner.contextId, {}), { code: 'MODEL_INTERACTION_MISMATCH' });
    assert.equal(env.counters.model, 2);
  });
}

test('a saved follow A waits for the original interaction instead of recreating start A', async (t) => {
  const env = environment(t, { timeoutMs: 200, delayMs: 120 });
  const store = new CapturedStore();
  const expected = await assemble(new SelectHistory(), store, env.providers).run(env.selection, {});
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'observer.follow-model' && write.image.point === 'waiting');
  assert.ok(boundary > 0, 'the first local wait delivered pending and established a follow call');
  const resumed = assemble(new SelectHistory(), restore(store.writes.slice(0, boundary + 1)), env.providers);
  assert.deepEqual(await resumed.resume(store.writes[0].image.frame.owner.contextId, {}), expected);
  assert.equal(env.counters.model, 1);
});
