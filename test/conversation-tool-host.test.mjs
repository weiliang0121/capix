import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { ToolExchanges, assertArchiveAdmission, ConversationArchiveFull, createToolConversationInteractions, readToolCheckpoint } from '@capix/conversation-service/tools/hosting';
import { CompletionInteraction } from '@capix/conversation-service';
import { requireModelReply } from '@capix/model-provider';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'capix-tool-host-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return join(path, 'conversation.sqlite');
}
function run(mode, path) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['test/fixtures/tool-host-prepared.mjs', mode, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code, ...JSON.parse(stdout), stderr });
      } catch {
        reject(new Error(`Fixture ${mode} exited ${code}: ${stderr} ${stdout}`));
      }
    });
  });
}
for (const boundary of ['prepared', 'initialized'])
  test(`tool host restores the exact ${boundary} allocation in a new process`, async (t) => {
    const path = directory(t);
    const stopped = await run(`crash-${boundary}`, path);
    assert.equal(stopped.code, 73, stopped.stderr);
    assert.equal(stopped.requests, 0);
    assert.equal(stopped.collections.items.length, boundary === 'prepared' ? 0 : 1);
    const resumed = await run('resume', path);
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.result, 'done');
    assert.equal(resumed.loaded, 0);
    assert.equal(resumed.collections.items.length, 1);
    if (boundary === 'initialized') assert.equal(resumed.collections.items[0].id, stopped.collections.items[0].id);
    assert.equal(resumed.requests, 2);
  });
test('waiting without the first loop CP cannot be treated as prepared', async (t) => {
  const path = directory(t);
  assert.equal((await run('crash-waiting', path)).code, 73);
  const resumed = await run('resume', path);
  assert.equal(resumed.code, 1);
  assert.equal(resumed.requests, 0);
  assert.equal(resumed.loaded, 0);
  assert.equal(resumed.collections.items.length, 1);
});
test('separate entries use separate archives, release memory and account for the two preparation saves', async (t) => {
  const result = await run('twice', directory(t));
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.collections.items.length, 2);
  assert.equal(result.loaded, 0);
  const saves = result.measurements.filter((row) => row.key === 'conversation.tools.archived-answer');
  assert.equal(saves.filter((row) => row.point === 'prepared').length, 2);
  assert.equal(saves.filter((row) => row.point === 'waiting').length, 2);
  assert.ok(saves.every((row) => row.bytes > 0 && row.syncMs >= 0));
  assert.ok(result.usage.checkpointBytes > 0 && result.usage.interactionsBytes > 0 && result.usage.exchangesBytes > 0);
  t.diagnostic(JSON.stringify({ archiveUsage: result.usage, preparation: saves.filter((row) => row.point !== 'completed') }));
});
test('entry use owns only its references; missing archives are never recreated by acquire', (t) => {
  const store = ConversationStore.open(directory(t));
  t.after(() => store.close());
  const content = loadConversationContent(store);
  const archives = new ToolExchanges(store.exchanges);
  const useA = archives.openUse();
  const plan = useA.plan({ source: { transcriptId: content.transcript.id, index: 0 }, policy: { version: 1 }, limits: { entries: 8, bytes: 10000 } });
  assert.equal(store.exchanges.list().items.length, 0);
  assert.throws(() => useA.acquireExisting(plan.selection, plan.metadata), /missing/);
  useA.initializePrepared(plan);
  const useB = archives.openUse();
  useB.acquireExisting(plan.selection, plan.metadata);
  const busy = archives.openUse();
  busy.close();
  useA.close();
  assert.equal(archives.loadedCount, 1);
  assert.equal(useB.requireLoaded(plan.selection).id, plan.selection.collection);
  assert.throws(() => useA.requireLoaded(plan.selection), /closed/);
  useB.close();
  assert.equal(archives.loadedCount, 0);
  assert.equal(store.exchanges.list().items.length, 1);
});
test('archive gate is a whole-store entry threshold, not a write quota or growth guarantee', () => {
  const usage = { exchangesBytes: 100, interactionsBytes: 400, checkpointBytes: 500, totalBytes: 1000 };
  const policy = { thresholdBytes: 2000, headroomBytes: 500, maxPendingReplyBytes: 300 };
  assert.doesNotThrow(() => assertArchiveAdmission(usage, 1, policy));
  assert.throws(() => assertArchiveAdmission(usage, 2, policy), ConversationArchiveFull);
  assert.throws(() => assertArchiveAdmission({ ...usage, checkpointBytes: 1000, totalBytes: 1500 }, 0, policy), { code: 'CONVERSATION_ARCHIVE_FULL', message: /交换 100 bytes，模型交互 400 bytes，CP 1000 bytes/ });
});

for (const boundary of ['initialize', 'load'])
  test(`reentrant use closure during archive ${boundary} cannot leak a loaded entity`, (t) => {
    const store = ConversationStore.open(directory(t));
    t.after(() => store.close());
    const content = loadConversationContent(store);
    let use;
    const archives = new ToolExchanges({
      initialize(...args) {
        store.exchanges.initialize(...args);
        if (boundary === 'initialize') use.close();
      },
      load(...args) {
        const result = store.exchanges.load(...args);
        if (boundary === 'load') use.close();
        return result;
      },
      commit: (...args) => store.exchanges.commit(...args),
      list: (...args) => store.exchanges.list(...args),
    });
    use = archives.openUse();
    const plan = use.plan({ source: { transcriptId: content.transcript.id, index: 0 }, policy: { version: 1 }, limits: { entries: 8, bytes: 10000 } });
    assert.throws(() => use.initializePrepared(plan), /closed/);
    use.close();
    assert.equal(archives.loadedCount, 0);
    assert.equal(store.exchanges.list().items.length, 1, 'Already saved empty intent remains a real fact');
  });

test('oversized tool model replies become interaction failures before successful feedback persistence', async () => {
  const saved = new Map();
  const reply = requireModelReply({ formatVersion: 1, id: 'reply', model: 'fixture', output: [{ kind: 'text', text: 'x'.repeat(4000) }], termination: { kind: 'completed', reason: 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } });
  const provider = { inspectRequest: () => ({ requestBytes: 100, wireBytes: 100 }), complete: async () => reply };
  const interactions = createToolConversationInteractions(
    provider,
    {
      create(state) {
        saved.set(state.id, structuredClone(state));
      },
      commit(change) {
        saved.set(change.state.id, structuredClone(change.state));
      },
    },
    { maxReplyBytes: 1024 },
  );
  const channel = interactions.bind(CompletionInteraction);
  const ref = channel.start({ messages: [{ role: 'user', content: 'hello' }] });
  await interactions.settled();
  assert.equal(channel.read(ref).kind, 'unavailable');
  assert.equal(saved.get(ref.id).feedback, undefined);
  assert.ok(saved.get(ref.id).failure);
  interactions.close();
});

test('prepared qualification reads the current head and rejects a consumed child order cursor', async (t) => {
  const path = directory(t);
  await run('crash-prepared', path);
  const store = ConversationStore.open(path);
  t.after(() => store.close());
  const root = store.checkpoints.listRoots()[0];
  const id = root.image.frame.children[0].identity.contextId;
  const head = readToolCheckpoint(store.checkpoints, id);
  assert.equal(head.image.point, 'prepared');
  const changed = structuredClone(head);
  changed.image.frame.nextChildOrder = 1;
  assert.throws(() => readToolCheckpoint({ read: () => changed }, id), /prior child activity/);
});

test('archive adapters cannot substitute a different collection under matching metadata', (t) => {
  const store = ConversationStore.open(directory(t));
  t.after(() => store.close());
  const content = loadConversationContent(store);
  const metadata = { source: { transcriptId: content.transcript.id, index: 0 }, policy: { version: 1 }, limits: { entries: 8, bytes: 10000 } };
  const normal = new ToolExchanges(store.exchanges).openUse();
  const plan = normal.plan(metadata);
  normal.initializePrepared(plan);
  normal.close();
  const archives = new ToolExchanges({
    initialize: (...args) => store.exchanges.initialize(...args),
    list: (...args) => store.exchanges.list(...args),
    commit: (...args) => store.exchanges.commit(...args),
    load(id) {
      const saved = store.exchanges.load(id);
      return { ...saved, state: { ...saved.state, id: 'different-collection' } };
    },
  });
  const use = archives.openUse();
  assert.throws(() => use.acquireExisting(plan.selection, plan.metadata), /incompatible/);
  use.close();
  assert.equal(archives.loadedCount, 0);
});
