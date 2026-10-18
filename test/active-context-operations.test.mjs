import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeDefinition, ExecutionDefinition, OperationDefinition, MemoryCheckpointStore, checkpointPoint, childReference, assembleRuntime } from '@capix/server-runtime';
import { MemoryResource } from '@capix/server-runtime/content';
import { ConversationContent } from '@capix/observer-service/assembly';
import { ActiveContentResource, PrepareConversationContextDefinition, MaintainConversationContentDefinition, ModelSettingsResource } from '@capix/observer-service/conversation';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 256, timeoutMs: 1000 };
const codec = { encode: structuredClone, decode: structuredClone };
const message = (content) => ({ role: 'user', content });
const createMemory = (content) => ({ action: 'create', memoryId: null, change: '记忆建立', sourceIndexes: [0], result: { topic: '偏好', content, sourceIndexes: [0] } });
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
function replay(writes) {
  const store = new MemoryCheckpointStore();
  for (const write of writes) {
    if (write.image) store.save(write.image, write.revision);
    else store.finish(write.id, write.revision, write.delivery);
  }
  return store;
}
function checkpoint(key, child) {
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
          uses: [child],
          async execute(work, _state, saved) {
            const child = work.children.resume(saved.child);
            await child.run();
            return child.accept();
          },
        },
      }),
    ],
  };
}
function runtime(operation, content, store = new CapturedStore(), options = {}) {
  class E extends ExecutionDefinition {
    children = [operation];
    checkpoint = checkpoint('active.fixture.e', operation);
    run = {
      requires: operation.run.requires,
      async execute(work) {
        const child = work.children.create(operation, work.input);
        work.checkpoint.save(thisCheckpoint.points[0], null, { child: child.ref });
        options.afterCreated?.();
        await child.run();
        return child.accept();
      },
    };
  }
  const execution = new E();
  const thisCheckpoint = execution.checkpoint;
  class R extends RuntimeDefinition {
    children = [execution];
    checkpoint = checkpoint('active.fixture.r', execution);
    run = {
      requires: {},
      execute: async (work) => {
        const child = work.children.create(execution, work.input);
        work.checkpoint.save(this.checkpoint.points[0], null, { child: child.ref });
        await child.run();
        return child.accept();
      },
    };
  }
  return assembleRuntime(new R(), {
    checkpoints: { store },
    providers: [ActiveContentResource.read.provide(() => content.active), ActiveContentResource.manage.provide(() => content.active), ModelSettingsResource.snapshot.provide(() => settings), MemoryResource.apply.provide(() => content.memories)],
    source: {
      capture: () => null,
      progress: () => ({
        receive: (fact) => {
          options.progress?.push(fact);
        },
      }),
    },
  });
}
function input(content, index) {
  return { messageIndex: index, message: content.transcript.get(index) };
}
function save(content) {
  return { version: 1, transcript: content.transcript.exportState(), memories: content.memories.exportState(), active: content.active.exportState() };
}

test('unconfigured preparation captures current content at execution and never creates an empty maintenance call', async (t) => {
  const content = new ConversationContent({ messages: [message('old'), message('question')] });
  t.after(() => content.close());
  const progress = [];
  const prepared = await runtime(new PrepareConversationContextDefinition(), content, new CapturedStore(), { progress, afterCreated: () => content.transcript.append(message('just arrived')) }).run(input(content, 1), {});
  assert.deepEqual(prepared.selection.historyIndexes, [0, 2]);
  assert.deepEqual(
    prepared.context.selectedMessages.map((item) => item.message.content),
    ['old', 'just arrived'],
  );
  assert.equal(prepared.context.message, content.transcript.get(1));
  assert.equal(progress.filter((fact) => fact.kind === 'started' && fact.identity.level === 'operation').length, 1);
});

test('function maintenance is one real O, can remove current membership, and preparation keeps explicit current input', async (t) => {
  const content = new ConversationContent({ messages: [message('old'), message('question')] });
  t.after(() => content.close());
  const phases = [];
  const progress = [];
  const maintenance = new MaintainConversationContentDefinition(({ material, phase, settings: received }) => {
    phases.push(phase);
    assert.equal(received.contextBudget, settings.contextBudget);
    return { basis: material.basis, messageIndexes: [], memoryIds: [] };
  });
  const prepared = await runtime(new PrepareConversationContextDefinition(maintenance), content, new CapturedStore(), { progress }).run(input(content, 1), {});
  assert.deepEqual(phases, ['before-request']);
  assert.deepEqual(prepared.material.messages, []);
  assert.deepEqual(prepared.selection.historyIndexes, []);
  assert.equal(prepared.context.message.content, 'question');
  assert.equal(content.transcript.length, 2);
  assert.equal(progress.filter((fact) => fact.kind === 'started' && fact.identity.level === 'operation').length, 2);
});

test('a composed maintenance O may write content and choose from the new explicit basis without recursive maintenance', async (t) => {
  const content = new ConversationContent({ messages: [message('evidence')] });
  t.after(() => content.close());
  let calls = 0;
  const requires = { activeContentManager: ActiveContentResource.manage.request(), memoryWriter: MemoryResource.apply.request() };
  class Policy extends OperationDefinition {
    name = 'policy';
    label = 'policy';
    source = 'test';
    run = {
      requires,
      execute(work) {
        calls++;
        assert.equal(work.input.phase, 'after-content');
        work.resources.memoryWriter.apply([createMemory('new understanding')]);
        const material = work.resources.activeContentManager.capture();
        return { basis: material.basis, messageIndexes: [], memoryIds: material.memories.map((memory) => memory.id) };
      },
    };
  }
  const material = await runtime(new MaintainConversationContentDefinition(new Policy(), requires), content).run({ phase: 'after-content' }, {});
  assert.equal(calls, 1);
  assert.deepEqual(material.messages, []);
  assert.equal(material.memories[0].content, 'new understanding');
  assert.equal(content.memories.sequence, 1);
});

test('prepared completed checkpoint delivers fixed values after later content changes', async (t) => {
  const content = new ConversationContent({ messages: [message('old'), message('question')] });
  t.after(() => content.close());
  const store = new CapturedStore();
  const expected = await runtime(new PrepareConversationContextDefinition(), content, store).run(input(content, 1), {});
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'observer.prepare-context' && write.image.point === 'completed');
  assert.ok(boundary >= 0);
  content.transcript.append(message('later'));
  const restored = runtime(new PrepareConversationContextDefinition(), content, replay(store.writes.slice(0, boundary + 1)));
  const result = await restored.resume(store.writes[0].image.frame.owner.contextId, {});
  assert.deepEqual(result, expected);
  assert.ok(Object.isFrozen(result.material) && Object.isFrozen(result.material.messages[0].message));
});

test('maintenance accepted checkpoint installs only against its exact basis without rerunning the policy', async (t) => {
  const content = new ConversationContent({ messages: [message('old'), message('question')] });
  t.after(() => content.close());
  const initial = save(content);
  let calls = 0;
  const policy = ({ material }) => {
    calls++;
    return { basis: material.basis, messageIndexes: [1], memoryIds: [] };
  };
  const store = new CapturedStore();
  const expected = await runtime(new MaintainConversationContentDefinition(policy), content, store).run({ phase: 'after-content' }, {});
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'observer.maintain-context' && write.image.point === 'accepted');
  assert.ok(boundary >= 0);
  const restoredContent = new ConversationContent({ saved: initial });
  t.after(() => restoredContent.close());
  const restored = runtime(new MaintainConversationContentDefinition(policy), restoredContent, replay(store.writes.slice(0, boundary + 1)));
  assert.deepEqual(await restored.resume(store.writes[0].image.frame.owner.contextId, {}), expected);
  assert.equal(calls, 1);
  const ambiguous = runtime(new MaintainConversationContentDefinition(policy), content, replay(store.writes.slice(0, boundary + 1)));
  await assert.rejects(ambiguous.resume(store.writes[0].image.frame.owner.contextId, {}), /活跃材料依据已经变化/);
  assert.equal(calls, 1, 'same target is not evidence that this pending apply happened');
});

test('maintenance completed checkpoint does not repeat an installed index change or its policy', async (t) => {
  const content = new ConversationContent({ messages: [message('old'), message('question')] });
  t.after(() => content.close());
  let calls = 0;
  const policy = ({ material }) => {
    calls++;
    return { basis: material.basis, messageIndexes: [1], memoryIds: [] };
  };
  const store = new CapturedStore();
  const expected = await runtime(new MaintainConversationContentDefinition(policy), content, store).run({ phase: 'after-content' }, {});
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'observer.maintain-context' && write.image.point === 'completed');
  assert.ok(boundary >= 0);
  content.transcript.append(message('later'));
  const revision = content.active.capture().basis.indexRevision;
  const restored = runtime(new MaintainConversationContentDefinition(policy), content, replay(store.writes.slice(0, boundary + 1)));
  assert.deepEqual(await restored.resume(store.writes[0].image.frame.owner.contextId, {}), expected);
  assert.equal(content.active.capture().basis.indexRevision, revision);
  assert.equal(calls, 1);
});

test('preparation and maintenance resume their actual waiting child before accepting and installing its decision', async (t) => {
  const content = new ConversationContent({ messages: [message('old'), message('question')] });
  t.after(() => content.close());
  const initial = save(content);
  let calls = 0;
  class Policy extends OperationDefinition {
    name = 'policy';
    label = 'policy';
    source = 'test';
    completed = checkpointPoint()({ name: 'completed', state: codec, references: {}, resume: { execute: (_work, output) => output } });
    checkpoint = { key: 'active.fixture.policy', version: 1, input: codec, output: codec, points: [this.completed] };
    run = {
      requires: {},
      execute: (work) => {
        calls++;
        const decision = { basis: work.input.material.basis, messageIndexes: [0], memoryIds: [] };
        work.checkpoint.save(this.completed, decision, {});
        return decision;
      },
    };
  }
  const store = new CapturedStore();
  const definition = () => new PrepareConversationContextDefinition(new MaintainConversationContentDefinition(new Policy()));
  const expected = await runtime(definition(), content, store).run(input(content, 1), {});
  const boundary = store.writes.findIndex((write) => write.image?.contract.key === 'active.fixture.policy' && write.image.point === 'completed');
  assert.ok(boundary >= 0);
  const restoredContent = new ConversationContent({ saved: initial });
  t.after(() => restoredContent.close());
  const restored = runtime(definition(), restoredContent, replay(store.writes.slice(0, boundary + 1)));
  assert.deepEqual(await restored.resume(store.writes[0].image.frame.owner.contextId, {}), expected);
  assert.equal(calls, 1);
  assert.deepEqual(restoredContent.active.exportState(), content.active.exportState());
});
