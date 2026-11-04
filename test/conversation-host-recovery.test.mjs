import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { createConversationWebHost } from '@capix/conversation-service/web';
import { ClientSubmission } from '@capix/client-runtime';

const entry = fileURLToPath(new URL('../services/conversation/dist/start.js', import.meta.url));
const injection = fileURLToPath(new URL('./fixtures/conversation-host-crash.mjs', import.meta.url));

function cli(database, args, crash) {
  const child = spawn(process.execPath, [...(crash ? ['--import', injection] : []), entry, '--demo', '--db', database, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_API_KEY: '', CAPIX_TEST_CRASH: crash ?? '' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (part) => (stdout += part));
  child.stderr.on('data', (part) => (stderr += part));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function fixture(t, stage) {
  const directory = await mkdtemp(join(tmpdir(), 'capix-host-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'conversation.sqlite');
  const crashed = await cli(database, ['--input', '保持简洁'], stage);
  assert.equal(crashed.signal, 'SIGKILL', crashed.stdout + crashed.stderr);
  const store = ConversationStore.open(database);
  const state = store.load();
  const root = store.checkpoints.listRoots().find((head) => head.image.contract.key === 'conversation.material-scene');
  store.close();
  assert.ok(root);
  assert.equal(root.delivery, undefined);
  return { database, state, root };
}

function load(database) {
  const store = ConversationStore.open(database);
  try {
    return { state: store.load(), heads: store.checkpoints.listRoots() };
  } finally {
    store.close();
  }
}

function answerSends(database) {
  const store = new DatabaseSync(database);
  try {
    return store.prepare("SELECT COUNT(*) AS count FROM completion_interactions WHERE COALESCE(json_extract(body, '$.request.responseFormat'), 'text') <> 'json_object'").get().count;
  } finally {
    store.close();
  }
}

for (const stage of ['answer-feedback', 'answer-append', 'memory-apply']) {
  test(`CLI explicitly resumes after ${stage}, never duplicating input, answer or fixed memory effect`, { timeout: 20_000 }, async (t) => {
    const { database, root } = await fixture(t, stage);
    assert.equal(answerSends(database), 1);
    const resumed = await cli(database, ['--resume', root.image.frame.owner.contextId]);
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
    assert.match(resumed.stdout, /续接：/);
    assert.match(resumed.stdout, /正式回答：/);
    const saved = load(database);
    assert.equal(saved.state.transcript.messages.length, 2);
    assert.deepEqual(
      saved.state.transcript.messages.map((message) => message.role),
      ['user', 'assistant'],
    );
    assert.equal(saved.state.memories.items.length, 1);
    assert.equal(saved.state.memories.sequence, 1);
    assert.equal(saved.state.memories.applies.length, 1);
    assert.equal(saved.state.view.members.length, 3);
    assert.equal(saved.heads[0].delivery.status, 'succeeded');
    assert.equal(answerSends(database), 1);
    const again = await cli(database, ['--resume', root.image.frame.owner.contextId]);
    assert.equal(again.code, 1);
    assert.deepEqual(load(database).state, saved.state);
    assert.equal(answerSends(database), 1);
  });
}

test('a crash with no saved model reply is refused instead of silently re-sending', { timeout: 20_000 }, async (t) => {
  const { database, root, state } = await fixture(t, 'prepared-request');
  const result = await cli(database, ['--resume', root.image.frame.owner.contextId]);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, /正式回答：/);
  assert.equal(answerSends(database), 1);
  assert.deepEqual(load(database).state, state);
});

test('HTTP recovery has a new submission, streams actual resumed appends and exposes separate recovery metadata', { timeout: 20_000 }, async (t) => {
  const { database, root } = await fixture(t, 'answer-feedback');
  let requests = 0;
  const model = {
    async complete(request) {
      requests++;
      assert.equal(request.responseFormat, 'json_object', 'saved answer must be read instead of sent again');
      return { id: 'memory', model: 'fixture', text: '{"changes":[]}', finishReason: 'stop', usage: null };
    },
  };
  const host = createConversationWebHost({ database, model, modelName: 'offline-demo', mode: 'demo' });
  t.after(() => host.close());
  await new Promise((resolve, reject) => {
    host.server.once('error', reject);
    host.server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const get = async (path) => {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const session = await get('/api/session');
  const candidates = await get('/api/recoveries');
  assert.equal(candidates[0].contextId, root.image.frame.owner.contextId);
  assert.equal(candidates[0].available, true);
  const feed = await fetch(origin + `/api/transcript/observe?id=${session.transcriptId}`);
  const reader = feed.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  async function nextFrame() {
    for (;;) {
      const end = pending.indexOf('\n');
      if (end >= 0) {
        const value = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        return value;
      }
      const part = await reader.read();
      assert.equal(part.done, false);
      pending += decoder.decode(part.value, { stream: true });
    }
  }
  assert.equal((await nextFrame()).snapshot.messages.length, 1);
  const body = { conversationId: session.conversationId, submissionId: 'resume-submission', contextId: root.image.frame.owner.contextId };
  const post = (value = body, path = '/api/resume') => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });
  const response = await post();
  assert.equal(response.status, 200, await response.clone().text());
  const frames = (await response.text()).trim().split('\n').map(JSON.parse);
  const client = ClientSubmission.attach({ conversationId: session.conversationId, submissionId: body.submissionId }, session.transcriptId);
  for (const frame of frames) client.receiveFrame(frame);
  assert.equal(client.snapshot.remote.result.status, 'completed');
  assert.equal(client.snapshot.remote.input.start, 0);
  assert.equal(client.snapshot.remote.answer.index, 1);
  assert.equal(client.snapshot.remote.executions[0].contextId, body.contextId);
  const append = await nextFrame();
  assert.equal(append.type, 'delta');
  assert.equal(append.event.change.messages[0].role, 'assistant');
  assert.equal(append.event.origin.contextId, body.contextId);
  await reader.cancel();
  const activity = await get('/api/recovery-activity');
  assert.equal(activity.complete, true);
  assert.ok(activity.events.some((event) => event.kind === 'installed' && event.contextId === body.contextId));
  assert.ok(activity.events.some((event) => event.kind === 'finished' && event.contextId === body.contextId && event.status === 'succeeded'));
  assert.ok(activity.events.every((event) => !('frame' in event) && !('input' in event) && !('output' in event)));
  assert.equal((await get('/api/inspection')).recording.calls.length, 0, 'recovery does not fabricate historical Scene records');
  assert.equal((await get(`/api/transcript?id=${session.transcriptId}`)).messages.length, 2);
  assert.deepEqual(await get('/api/recoveries'), []);
  assert.equal(requests, 1);
  const duplicate = await post();
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.text()).trim().split('\n').map(JSON.parse)[0].submission.result.status, 'completed');
  assert.equal(requests, 1);
  const conflicting = await post({ conversationId: session.conversationId, submissionId: body.submissionId, input: { messages: [{ role: 'user', content: 'new input' }] } }, '/api/run');
  assert.equal(conflicting.status, 409);
  assert.equal((await conflicting.json()).code, 'SUBMISSION_EXISTS');
  const terminal = await post({ ...body, submissionId: 'resume-again' });
  assert.equal(terminal.status, 200);
  const rejected = (await terminal.text()).trim().split('\n').map(JSON.parse)[0].submission;
  assert.equal(rejected.result.status, 'rejected');
  assert.equal(rejected.result.error.code, 'RECOVERY_UNAVAILABLE');
  assert.equal(rejected.input, undefined);
});
