import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObserverConversations, createObserverServer, WorkspaceFiles } from '@capix/observer-service';
import { ClientRuntime } from '@capix/client-runtime';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix/client-http';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
const task = { sourcePath: 'notes.md', output: { path: 'summary.md' } };
const answer = '文件中的内容已经改写。';
const output = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });

async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'file observation did not reach the expected state');
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'capix-file-observation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, task.sourcePath), '要改写的文件正文。');
  const conversations = new ObserverConversations(
    {
      async invoke(_request, purpose) {
        if (purpose === 'selection') return output({ historyIndexes: [] });
        if (purpose === 'understanding') return output({ kind: 'file', task, instruction: '改写文件并保存结果。' });
        if (purpose === 'answer') return output({ kind: 'answer', content: answer });
        return output({ memories: [] });
      },
    },
    [],
    { files: new WorkspaceFiles({ root }) },
  );
  const conversationId = conversations.list().defaultConversationId;
  const environment = conversations.open(conversationId);
  const server = createObserverServer({ conversations, settings, configured: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  const observation = new ObservationHttpTransport(base, (url, init) => {
    requests.push(new URL(url).pathname);
    return fetch(url, init);
  });
  const conversation = new ConversationHttpTransport(base);
  const runtime = new ClientRuntime({ conversation, transcripts: conversation, observation });
  const stops = [];
  t.after(async () => {
    for (const stop of stops) stop();
    runtime.stopFollowing();
    runtime.stopTranscript();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    conversations.close();
  });
  await runtime.initialize();
  return {
    root,
    runtime,
    observation,
    requests,
    observe: () => stops.push(runtime.startObservation()),
    run: () => runtime.submit({ messages: [{ role: 'user', content: 'notes.md 改写后保存到 summary.md' }] }),
  };
}

function assertFileCalls(snapshot) {
  assert.equal(snapshot.execution.status, 'succeeded');
  assert.equal(snapshot.rootCall.status, 'succeeded');
  const fileCalls = snapshot.calls.filter((attempt) => ['inspectFileTask', 'readText', 'createText'].includes(attempt.name));
  assert.deepEqual(
    fileCalls.map((call) => call.name),
    ['inspectFileTask', 'readText', 'createText'],
    'preflight, read and create retain distinct callable identities',
  );
  assert.ok(fileCalls.every((attempt) => attempt.status === 'succeeded'));
  const nested = snapshot.calls.find((call) => call.structureKind === 'group' && call.id !== snapshot.execution.id && call.parentId !== snapshot.execution.id);
  assert.ok(nested, 'document generation remains a nested O instead of being flattened to E');
  assert.ok(snapshot.calls.some((call) => call.id === nested.parentId));
}

test('file read-and-save deltas reach a completed client observation without stopping at the first file A', async (t) => {
  const f = await fixture(t);
  f.observe();
  await until(() => !f.runtime.getSnapshot().observation.loading);
  await f.run();
  assert.equal(f.runtime.getSnapshot().submission.remote.result.status, 'completed');
  assert.equal(f.runtime.getSnapshot().submission.remote.fileOutput.status, 'created');
  assert.equal(await readFile(join(f.root, task.output.path), 'utf8'), answer);
  await until(() => {
    const state = f.runtime.getSnapshot().observation;
    return Boolean(state.error) || [...state.records.values()].some((snapshot) => snapshot.rootCall.status === 'succeeded');
  });
  const state = f.runtime.getSnapshot().observation;
  assert.equal(state.error, undefined);
  assert.equal(state.records.size, 1);
  const live = [...state.records.values()][0];
  assertFileCalls(live);
  assert.deepEqual(f.requests, ['/api/observe'], 'live deltas do not fall back to repeated full snapshot queries');

  await f.runtime.refreshObservation();
  await until(() => !f.runtime.getSnapshot().observation.loading);
  assert.equal(f.runtime.getSnapshot().observation.error, undefined);
  assert.equal(f.runtime.getSnapshot().observation.records.size, 0, 'completed record bodies stay lazy after reconnect');
  const overview = f.runtime.getSnapshot().observation.overview;
  assert.equal(overview.executions[0].status, 'succeeded');
  const loaded = await f.runtime.loadExecution(overview.executions[0].id);
  assertFileCalls(loaded);
  assert.deepEqual(loaded, live, 'incremental reconstruction and a later full detail read preserve the same records');
});

test('completed file records load on demand through the same protocol contract as live observation', async (t) => {
  const f = await fixture(t);
  await f.run();
  const overview = await f.observation.overview(f.runtime.getSnapshot().conversation.id);
  assert.equal(overview.executions[0].status, 'succeeded');
  const snapshot = await f.runtime.loadExecution(overview.executions[0].id);
  assertFileCalls(snapshot);
  assert.deepEqual(f.requests, ['/api/executions', '/api/execution']);
});
