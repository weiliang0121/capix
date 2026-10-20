import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Transcript, Memories } from '@capix/server-runtime/content';
import { ObserverConversations, SqliteObserverStore, MemoryConversationCheckpointRuns, copyConversationCheckpointRun, checkpointTranscriptFingerprint, validateConversationCheckpointContent, validateConversationCheckpointDeliveryContent, validateConversationCheckpointReceipt, validateConversationCheckpointHeads } from '@capix/observer-service/assembly';

const settings = { model: 'test', contextBudget: 16000, maxOutputTokens: 1536, timeoutMs: 1000 };
const raw = (value) => ({ id: 'fixture', model: 'test', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const provider = {
  async invoke(_request, purpose) {
    return raw(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: 'reply' });
  },
};
function basis(transcript, memories, overrides = {}) {
  return { conversationId: 'conversation', rootContextId: 'root', executionContextId: 'execution', settings, configuration: { files: false, maxDecisionSteps: 8, customDecision: false }, transcript: { transcriptId: transcript.id, start: transcript.activeStart, end: transcript.length, revision: transcript.revision, fingerprint: checkpointTranscriptFingerprint(transcript, 0, transcript.length) }, input: { transcriptId: transcript.id, start: 0, end: transcript.length, revision: transcript.revision }, memories: { id: memories.id, sequence: memories.sequence }, ...overrides };
}
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-service-cp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'observer.sqlite');
}

test('normal new conversation calls install CP and register real input plus fixed construction bounds', async () => {
  const facts = [];
  const host = new ObserverConversations(provider, [], { checkpointObservation: { observe: (fact) => facts.push(fact) } });
  const conversation = host.create();
  const environment = host.open(conversation.id);
  const options = { settings: { ...settings } };
  await environment.driver.run(environment.scene, { messages: [{ role: 'user', content: 'hello' }] }, options);
  const [run] = environment.checkpointRuns.list(conversation.id);
  assert.equal(run.conversationId, conversation.id);
  assert.deepEqual(run.input, { transcriptId: environment.transcript.id, start: 0, end: 1, revision: 1 });
  assert.equal(run.transcript.end, 1);
  assert.equal(environment.transcript.length, 2);
  assert.ok(environment.checkpoints.read(run.rootContextId));
  assert.equal(environment.checkpoints.read(run.rootContextId).delivery.status, 'succeeded');
  assert.ok(facts.some((fact) => fact.kind === 'saved' && fact.contextId === run.rootContextId));
  options.settings.model = 'changed';
  assert.equal(run.settings.model, 'test');
  await assert.rejects(host.recover(conversation.id, run.rootContextId));
  assert.equal(environment.transcript.length, 2);
  await environment.driver.run(environment.scene, { messages: [{ role: 'user', content: 'again' }] }, { settings });
  assert.equal(environment.checkpointRuns.list(conversation.id).length, 2);
  assert.equal(environment.checkpointRuns.read(host.list().defaultConversationId, run.rootContextId), undefined);
  host.close();
});

test('checkpoint installation reuses the host SQLite connection and recovers metadata without replay', async (t) => {
  const path = temporary(t);
  const persistence = SqliteObserverStore.open(path);
  const host = new ObserverConversations(provider, [], { persistence });
  const conversation = host.list().conversations[0];
  const environment = host.open(conversation.id);
  assert.equal(environment.checkpoints, persistence.checkpoints);
  assert.equal(environment.checkpointRuns, persistence.checkpointRuns);
  await environment.driver.run(environment.scene, { messages: [{ role: 'user', content: 'persist' }] }, { settings });
  const [run] = environment.checkpointRuns.list(conversation.id);
  const saved = persistence.checkpoints.read(run.rootContextId);
  host.close();
  const restored = SqliteObserverStore.open(path);
  const next = new ObserverConversations(
    {
      invoke() {
        assert.fail('opening historical content must not call the model');
      },
    },
    [],
    { persistence: restored },
  );
  assert.deepEqual(restored.checkpointRuns.read(conversation.id, run.rootContextId), run);
  assert.deepEqual(restored.checkpoints.read(run.rootContextId), saved);
  assert.equal(next.content(conversation.id).transcript.length, 2);
  assert.equal(next.peek(conversation.id), undefined);
  const other = next.create();
  assert.equal(restored.checkpointRuns.read(other.id, run.rootContextId), undefined);
  await assert.rejects(next.recover(other.id, run.rootContextId), { code: 'CHECKPOINT_NOT_FOUND' });
  next.close();
});

for (const formatVersion of [1, 2, 3, 99]) {
  test(`checkpoint format ${formatVersion} refuses recovery without preventing healthy content and new calls`, async (t) => {
    const path = temporary(t);
    const host = new ObserverConversations(provider, [], { persistence: SqliteObserverStore.open(path) });
    const conversation = host.list().conversations[0];
    const environment = host.open(conversation.id);
    await environment.driver.run(environment.scene, { messages: [{ role: 'user', content: 'before upgrade' }] }, { settings });
    const [run] = environment.checkpointRuns.list(conversation.id);
    const original = environment.transcript.exportState();
    host.close();

    const database = new DatabaseSync(path);
    const rows = database.prepare('SELECT id, body FROM checkpoint_images').all();
    for (const row of rows) {
      const image = JSON.parse(row.body);
      image.formatVersion = formatVersion;
      database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(JSON.stringify(image), row.id);
    }
    database.close();

    const persistence = SqliteObserverStore.open(path);
    const restored = new ObserverConversations(provider, [], { persistence });
    t.after(() => restored.close());
    assert.deepEqual(restored.content(conversation.id).transcript.exportState(), original);
    assert.throws(() => persistence.checkpoints.read(run.rootContextId), { code: 'CHECKPOINT_FORMAT_UNSUPPORTED' });
    await assert.rejects(restored.recover(conversation.id, run.rootContextId), { code: 'CHECKPOINT_FORMAT_UNSUPPORTED' });
    const current = restored.open(conversation.id);
    await current.driver.run(current.scene, { messages: [{ role: 'user', content: 'after upgrade' }] }, { settings });
    assert.equal(current.transcript.length, 4);
    const latest = current.checkpointRuns.list(conversation.id).find((candidate) => candidate.rootContextId !== run.rootContextId);
    assert.equal(current.checkpoints.read(latest.rootContextId).image.formatVersion, 4);
  });
}

test('capture preserves the full accepted history when capacity checking rejects the request', async () => {
  const host = new ObserverConversations(provider);
  const conversation = host.create();
  const environment = host.open(conversation.id);
  await assert.rejects(
    environment.driver.run(
      environment.scene,
      {
        messages: [
          { role: 'user', content: 'large'.repeat(20000) },
          { role: 'assistant', content: 'old' },
          { role: 'user', content: 'short' },
        ],
      },
      { settings },
    ),
    { code: 'CAPACITY_EXCEEDED' },
  );
  const [run] = environment.checkpointRuns.list(conversation.id);
  assert.equal(run.input.start, 0);
  assert.equal(run.input.end, 3);
  assert.equal(run.transcript.start, 0);
  assert.equal(run.transcript.end, 3);
  host.close();
});

test('registered run basis is immutable, unique, and rejects disguised live values', () => {
  const transcript = new Transcript([{ role: 'user', content: 'hello' }]);
  const memories = new Memories(transcript);
  const runs = new MemoryConversationCheckpointRuns();
  const source = basis(transcript, memories);
  runs.register(source);
  source.settings = { ...settings, model: 'mutation' };
  assert.equal(runs.read('conversation', 'root').settings.model, 'test');
  assert.throws(() => runs.register(source), { code: 'CHECKPOINT_CONFLICT' });
  let reads = 0;
  assert.throws(() =>
    copyConversationCheckpointRun({
      get conversationId() {
        reads++;
        return 'conversation';
      },
    }),
  );
  assert.equal(reads, 0);
});

test('content validation admits only the original prefix and this execution fixed answer receipt', () => {
  const transcript = new Transcript([{ role: 'user', content: 'hello' }]);
  const memories = new Memories(transcript);
  const run = copyConversationCheckpointRun(basis(transcript, memories));
  validateConversationCheckpointContent(run, transcript, memories);
  transcript.applyFixed({ contract: { key: 'transcript.append', version: 1 }, operation: { parentContextId: 'execution', childContextId: 'generation', position: 'answer' }, transcriptId: transcript.id, messages: [{ role: 'assistant', content: 'answer' }] });
  validateConversationCheckpointContent(run, transcript, memories);
  transcript.append({ role: 'user', content: 'new QA' });
  assert.throws(() => validateConversationCheckpointContent(run, transcript, memories), { code: 'CHECKPOINT_CONTENT_CHANGED' });
  const rewritten = Transcript.restore({ ...transcript.exportState(), messages: [{ role: 'user', content: 'changed' }], revision: 1, appends: [], starts: [0] });
  assert.throws(() => validateConversationCheckpointContent(run, rewritten, memories), { code: 'CHECKPOINT_CONTENT_CHANGED' });
});

test('an accepted E checkpoint cannot claim a missing fixed append receipt', () => {
  const transcript = new Transcript([{ role: 'user', content: 'hello' }]);
  const memories = new Memories(transcript);
  const run = copyConversationCheckpointRun(basis(transcript, memories));
  const request = { contract: { key: 'transcript.append', version: 1 }, operation: { parentContextId: 'execution', childContextId: 'generation', position: 'answer' }, transcriptId: transcript.id, messages: [{ role: 'assistant', content: 'answer' }] };
  const receipt = { transcriptId: transcript.id, start: 1, count: 1, revision: 2 };
  const head = { image: { point: 'answerAccepted', frame: { owner: { contextId: 'execution', parentContextId: 'root' }, children: [{ identity: { contextId: 'generation', parentContextId: 'execution' }, order: 0, state: { kind: 'returned', reception: { kind: 'accepted' } } }] }, state: { childId: 'generation', selection: { historyIndexes: [] }, step: 1, checkedCandidates: [], progress: { answer: { kind: 'answer', content: 'answer' }, response: { index: 1, message: { role: 'assistant', content: 'answer' } }, receipt, responseOrder: 0 } } } };
  assert.throws(() => validateConversationCheckpointReceipt(run, transcript, head), { code: 'CHECKPOINT_CONTENT_CHANGED' });
  assert.deepEqual(transcript.applyFixed(request), receipt);
  validateConversationCheckpointReceipt(run, transcript, head);
  head.image.state.progress.receipt.revision = 3;
  assert.throws(() => validateConversationCheckpointReceipt(run, transcript, head), { code: 'CHECKPOINT_CONTENT_CHANGED' });
});

test('host recovery rejects different orchestration configuration before any provider work', async (t) => {
  const path = temporary(t);
  const host = new ObserverConversations(provider, [], { persistence: SqliteObserverStore.open(path) });
  const conversation = host.list().conversations[0];
  const environment = host.open(conversation.id);
  await environment.driver.run(environment.scene, { messages: [{ role: 'user', content: 'hello' }] }, { settings });
  const [run] = environment.checkpointRuns.list(conversation.id);
  host.close();
  const restored = new ObserverConversations(
    {
      invoke() {
        assert.fail('changed configuration must not execute');
      },
    },
    [],
    { persistence: SqliteObserverStore.open(path), maxDecisionSteps: 4 },
  );
  await assert.rejects(restored.recover(conversation.id, run.rootContextId), { code: 'CHECKPOINT_CONFIGURATION_CHANGED' });
  restored.close();
});

test('host association must match the exact R and E heads', () => {
  const transcript = new Transcript([{ role: 'user', content: 'hello' }]);
  const run = copyConversationCheckpointRun(basis(transcript, new Memories(transcript)));
  const child = { identity: { contextId: 'execution', parentContextId: 'root' } };
  const root = { image: { contract: { key: 'observer.conversation.scene', version: 4 }, frame: { input: { messages: [{ role: 'user', content: 'hello' }] }, owner: { contextId: 'root', kind: 'scene' }, children: [child] }, references: { execution: { contextId: 'execution' } }, state: null } };
  const execution = { image: { contract: { key: 'observer.conversation.task', version: 6 }, frame: { input: { message: { role: 'user', content: 'hello' }, messageIndex: 0 }, owner: { contextId: 'execution', parentContextId: 'root', kind: 'group' } } } };
  validateConversationCheckpointHeads(run, root, execution, transcript);
  execution.image.frame.input.messageIndex = 1;
  assert.throws(() => validateConversationCheckpointHeads(run, root, execution, transcript), { code: 'CHECKPOINT_CONTENT_CHANGED' });
  execution.image.frame.input.messageIndex = 0;
  root.image.contract.version = 2;
  assert.throws(() => validateConversationCheckpointHeads(run, root, execution, transcript), { code: 'CHECKPOINT_DECLARATION_CHANGED' });
  root.image.contract.version = 4;
  root.image.frame.input.messages[0].content = 'different';
  assert.throws(() => validateConversationCheckpointHeads(run, root, execution, transcript), { code: 'CHECKPOINT_CONTENT_CHANGED' });
  root.image.frame.input.messages[0].content = 'hello';
  root.image.references.execution.contextId = 'different';
  assert.throws(() => validateConversationCheckpointHeads(run, root, execution, transcript), { code: 'CHECKPOINT_CONTENT_CHANGED' });
  root.image.references.execution.contextId = 'execution';
  execution.image.frame.owner.parentContextId = 'different';
  assert.throws(() => validateConversationCheckpointHeads(run, root, execution, transcript), { code: 'CHECKPOINT_CONTENT_CHANGED' });
});

test('fixed final E delivery permits already committed memory without rerunning E', () => {
  const transcript = new Transcript([{ role: 'user', content: 'hello' }]);
  const memories = new Memories(transcript);
  const run = copyConversationCheckpointRun(basis(transcript, memories));
  transcript.applyFixed({ contract: { key: 'transcript.append', version: 1 }, operation: { parentContextId: 'execution', childContextId: 'generation', position: 'answer' }, transcriptId: transcript.id, messages: [{ role: 'assistant', content: 'answer' }] });
  memories.apply([{ action: 'create', memoryId: null, change: 'committed', sourceIndexes: [0, 1], result: { topic: 'saved', content: 'saved memory', sourceIndexes: [0, 1] } }]);
  assert.throws(() => validateConversationCheckpointContent(run, transcript, memories), { code: 'CHECKPOINT_CONTENT_CHANGED' });
  validateConversationCheckpointDeliveryContent(run, transcript, memories);
  const head = { image: { point: 'continuationBarrier' }, delivery: { status: 'succeeded', output: { kind: 'answer', content: 'answer' } } };
  validateConversationCheckpointReceipt(run, transcript, head);
  head.delivery.output.content = 'wrong';
  assert.throws(() => validateConversationCheckpointReceipt(run, transcript, head), { code: 'CHECKPOINT_CONTENT_CHANGED' });
  transcript.append({ role: 'user', content: 'new QA' });
  assert.throws(() => validateConversationCheckpointDeliveryContent(run, transcript, memories), { code: 'CHECKPOINT_CONTENT_CHANGED' });
});
