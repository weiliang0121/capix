import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initializeObserver, createObserverServer, WorkspaceFiles } from '@capix/observer-service';
import { ClientRuntime } from '@capix/client-runtime';
import { ConversationHttpTransport } from '@capix/client-http';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 10000 };
const output = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const request = (content, fileTask) => ({ messages: [{ role: 'user', content }], ...(fileTask ? { fileTask } : {}) });
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'file submission did not reach expected state');
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'capix-files-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'input.txt'), '文件正文 evidence-unique-中文');
  const calls = [];
  const files = options.disabled ? undefined : new WorkspaceFiles({ root });
  const environment = initializeObserver(
    {
      async invoke(modelRequest, purpose, signal) {
        calls.push({ purpose, request: modelRequest });
        if (purpose === 'selection') return output({ historyIndexes: [] });
        if (purpose === 'understanding') return output(typeof options.proposal === 'function' ? options.proposal(modelRequest) : (options.proposal ?? { kind: 'reply' }));
        if (purpose === 'memory') {
          if (options.memoryFails) throw new Error('memory failed after file publication');
          return output({ memories: [] });
        }
        return options.answer ? options.answer(modelRequest, signal) : output({ kind: 'answer', content: '文件摘要。' });
      },
    },
    [],
    { files },
  );
  const server = createObserverServer({ observer: environment, settings, configured: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const posts = [];
  const transport = new ConversationHttpTransport(base, (url, init) => {
    if (new URL(url).pathname === '/api/run') posts.push(JSON.parse(init.body));
    return fetch(url, init);
  });
  const conversation = options.transport ? options.transport(transport) : transport;
  const runtime = new ClientRuntime({ conversation, transcripts: transport });
  t.after(async () => {
    runtime.clearQueue();
    runtime.stopFollowing();
    runtime.stopTranscript();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await runtime.initialize();
  return { root, calls, files, environment, server, base, posts, transport, runtime };
}
async function settle(runtime, count = 1) {
  await until(() => [...runtime.getSnapshot().submissions.values()].filter((item) => item.remote?.result).length >= count);
  return runtime.getSnapshot().submission.remote;
}

test('HTTP file task reads evidence, creates answer bytes and delivers an independent receipt', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.transport.config()).files, { maxReadBytes: 65536, maxWriteBytes: 65536 });
  f.runtime.enqueue(request('请总结文件', { sourcePath: 'input.txt', output: { path: 'answer.md' } }));
  const snapshot = await settle(f.runtime);
  assert.equal(snapshot.result.status, 'completed');
  assert.equal(snapshot.fileOutput.status, 'created');
  const text = await readFile(join(f.root, 'answer.md'), 'utf8');
  assert.equal(text, '文件摘要。');
  assert.deepEqual(snapshot.fileOutput.receipt, { path: 'answer.md', bytes: Buffer.byteLength(text), digest: createHash('sha256').update(text).digest('hex') });
  assert.ok(JSON.stringify(f.calls.find((call) => call.purpose === 'answer').request).includes('evidence-unique-中文'));
  assert.deepEqual(
    f.environment.transcript.snapshot().map((message) => message.content),
    ['请总结文件', text],
  );
  assert.deepEqual((await readdir(f.root)).sort(), ['answer.md', 'input.txt']);
  const recovered = await f.transport.read(snapshot.submissionId);
  assert.deepEqual(recovered.fileOutput, snapshot.fileOutput);
});

test('disabled or invalid file tasks reject before appending input or invoking the model', async (t) => {
  const f = await fixture(t, { disabled: true });
  assert.equal((await f.transport.config()).files, undefined);
  const response = await fetch(`${f.base}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ submissionId: 'disabled', input: request('read', { sourcePath: 'input.txt' }) }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).result.status, 'rejected');
  assert.equal(f.environment.transcript.length, 0);
  assert.equal(f.calls.length, 0);
  const enabled = await fixture(t);
  const invalid = await fetch(`${enabled.base}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ submissionId: 'invalid', input: request('read', { sourcePath: '../outside' }) }) });
  assert.equal(invalid.status, 400);
  assert.equal(enabled.environment.transcript.length, 0);
  assert.equal(enabled.calls.length, 0);
});

test('a missing file is clarified before execution and releases admission for the next queued question', async (t) => {
  const f = await fixture(t);
  f.runtime.enqueue(request('read missing', { sourcePath: 'missing.txt', output: { path: 'never.md' } }));
  f.runtime.enqueue(request('ordinary question'));
  await settle(f.runtime, 2);
  const submissions = [...f.runtime.getSnapshot().submissions.values()];
  assert.equal(submissions[0].remote.result.status, 'completed');
  assert.deepEqual(submissions[0].remote.task, { kind: 'clarify' });
  assert.equal(submissions[0].remote.fileOutput, undefined);
  assert.equal(submissions[1].remote.result.status, 'completed');
  assert.equal(submissions[1].remote.fileOutput, undefined);
  assert.equal(f.environment.runtime.running, false);
  assert.deepEqual((await readdir(f.root)).sort(), ['input.txt']);
});

test('existing output is never overwritten and needs-info never creates an output', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'answer.md'), 'original');
  f.runtime.enqueue(request('read', { sourcePath: 'input.txt', output: { path: 'answer.md' } }));
  const checked = await settle(f.runtime);
  assert.equal(checked.result.status, 'completed');
  assert.deepEqual(checked.task, { kind: 'clarify' });
  assert.equal(checked.fileOutput, undefined);
  assert.equal(checked.answer.index, 1, 'preflight asks for a new path without generating or saving');
  assert.equal(
    f.calls.some((call) => call.purpose === 'answer'),
    false,
  );
  assert.equal(await readFile(join(f.root, 'answer.md'), 'utf8'), 'original');
  const clarify = await fixture(t, { answer: () => output({ kind: 'needs-info', content: '请明确摘要范围。' }) });
  clarify.runtime.enqueue(request('read', { sourcePath: 'input.txt', output: { path: 'answer.md' } }));
  const skipped = await settle(clarify.runtime);
  assert.equal(skipped.result.status, 'completed');
  assert.deepEqual(skipped.fileOutput, { status: 'not-created', path: 'answer.md', reason: 'not-started' });
  assert.equal(skipped.answer.index, 1);
  assert.deepEqual(await readdir(clarify.root), ['input.txt']);
});

test('memory failure preserves both formal answer and already published file receipt', async (t) => {
  const f = await fixture(t, { memoryFails: true });
  f.runtime.enqueue(request('read', { sourcePath: 'input.txt', output: { path: 'answer.md' } }));
  const snapshot = await settle(f.runtime);
  assert.equal(snapshot.result.status, 'failed');
  assert.equal(snapshot.answer.index, 1);
  assert.equal(snapshot.fileOutput.status, 'created');
  assert.equal(await readFile(join(f.root, 'answer.md'), 'utf8'), '文件摘要。');
});

test('lost feedback follows the same submission without repeating file creation', async (t) => {
  let interrupted = false;
  const reads = [];
  const f = await fixture(t, {
    transport: (io) => ({
      config: () => io.config(),
      admission: (signal) => io.admission(signal),
      read: (id, signal) => {
        reads.push(id);
        return io.read(id, signal);
      },
      follow: (id, receive, signal) => {
        reads.push(id);
        return io.follow(id, receive, signal);
      },
      cancel: (id, signal) => io.cancel(id, signal),
      submit: (input, receive, signal) =>
        io.submit(
          input,
          (snapshot) => {
            receive(snapshot);
            if (!interrupted && snapshot.input && !snapshot.result) {
              interrupted = true;
              throw new Error('fixture connection lost');
            }
          },
          signal,
        ),
    }),
  });
  f.runtime.enqueue(request('read', { sourcePath: 'input.txt', output: { path: 'answer.md' } }));
  const snapshot = await settle(f.runtime);
  assert.equal(snapshot.result.status, 'completed');
  assert.equal(snapshot.fileOutput.status, 'created');
  assert.equal(f.posts.length, 1);
  assert.ok(reads.length > 0);
  assert.ok(reads.every((id) => id === snapshot.submissionId));
  assert.equal(f.calls.filter((call) => call.purpose === 'answer').length, 1);
});

test('natural language selects a read-and-save branch with a stable remote task', async (t) => {
  const task = { sourcePath: 'input.txt', output: { path: 'natural.md' } };
  const f = await fixture(t, { proposal: { kind: 'file', task, instruction: '概括文档，保留重点。' } });
  f.runtime.enqueue(request('请读取 input.txt 并总结到 natural.md'));
  const snapshot = await settle(f.runtime);
  assert.equal(snapshot.result.status, 'completed');
  assert.deepEqual(snapshot.task, { kind: 'file', task });
  assert.equal(snapshot.fileOutput.status, 'created');
  assert.equal(await readFile(join(f.root, 'natural.md'), 'utf8'), '文件摘要。');
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['selection', 'understanding', 'answer', 'memory'],
  );
  assert.ok(JSON.stringify(f.calls.find((call) => call.purpose === 'answer').request).includes('概括文档，保留重点。'));
  const recovered = await f.transport.read(snapshot.submissionId);
  assert.deepEqual(recovered.task, snapshot.task);
});

for (const explicit of [true, false]) {
  test(`generate-and-save without a source file (${explicit ? 'explicit' : 'natural'})`, async (t) => {
    const task = { output: { path: 'draft.md' } };
    const f = await fixture(t, { proposal: { kind: 'file', task, instruction: '写一个问候语。' } });
    f.runtime.enqueue(request('写一个问候语保存到 draft.md', explicit ? task : undefined));
    const snapshot = await settle(f.runtime);
    assert.equal(snapshot.result.status, 'completed');
    assert.deepEqual(snapshot.task, { kind: 'file', task });
    assert.equal(snapshot.fileOutput.status, 'created');
    assert.equal(await readFile(join(f.root, 'draft.md'), 'utf8'), '文件摘要。');
    assert.equal(f.calls.filter((call) => call.purpose === 'understanding').length, explicit ? 0 : 1);
    assert.equal(JSON.stringify(f.calls.find((call) => call.purpose === 'answer').request).includes('evidence-unique-中文'), false);
  });
}

for (const proposal of [
  { kind: 'clarify', question: '请提供来源文件名。' },
  { kind: 'unsupported', explanation: '当前不能覆盖已有文件。' },
]) {
  test(`non-executable request is answered without file or answer-model calls: ${proposal.kind}`, async (t) => {
    const f = await fixture(t, { proposal });
    f.runtime.enqueue(request('处理一下这个文件'));
    const snapshot = await settle(f.runtime);
    assert.equal(snapshot.result.status, 'completed');
    assert.equal(snapshot.task.kind, proposal.kind === 'unsupported' ? 'unsupported' : 'clarify');
    assert.equal(snapshot.answer.index, 1);
    assert.equal(snapshot.fileOutput, undefined);
    assert.deepEqual(
      f.calls.map((call) => call.purpose),
      ['selection', 'understanding'],
    );
    assert.deepEqual(await readdir(f.root), ['input.txt']);
  });
}

test('an invalid model candidate can be corrected within this QA without asking the user', async (t) => {
  let proposals = 0;
  const f = await fixture(t, {
    proposal: (modelRequest) => {
      proposals++;
      if (proposals === 1) return { kind: 'file', task: { sourcePath: 'input.txt', output: { path: 'input.txt' } }, instruction: '总结文档' };
      assert.ok(JSON.stringify(modelRequest).includes('same-path'));
      return { kind: 'file', task: { sourcePath: 'input.txt' }, instruction: '总结文档' };
    },
  });
  f.runtime.enqueue(request('总结 input.txt，只在对话中回答'));
  const snapshot = await settle(f.runtime);
  assert.equal(snapshot.result.status, 'completed');
  assert.deepEqual(snapshot.task, { kind: 'file', task: { sourcePath: 'input.txt' } });
  assert.equal(proposals, 2);
  assert.equal(f.environment.transcript.length, 2);
  assert.deepEqual(await readdir(f.root), ['input.txt']);
});

test('natural user absolute paths inside the configured workspace do not need a clarification turn', async (t) => {
  const f = await fixture(t, { proposal: () => ({ kind: 'file', task: { sourcePath: join(f.root, 'input.txt'), output: { path: join(f.root, 'translated.md') } }, instruction: '翻译后保存' }) });
  f.runtime.enqueue(request(`把 ${join(f.root, 'input.txt')} 翻译并保存到 translated.md`));
  const snapshot = await settle(f.runtime);
  assert.equal(snapshot.result.status, 'completed');
  assert.deepEqual(snapshot.task, { kind: 'file', task: { sourcePath: 'input.txt', output: { path: 'translated.md' } } });
  assert.equal(snapshot.fileOutput.status, 'created');
  assert.equal(f.calls.filter((call) => call.purpose === 'understanding').length, 1);
});

test('a clarification response can choose a file branch on the next QA without replaying prior work', async (t) => {
  let understanding = 0;
  const f = await fixture(t, {
    proposal: (modelRequest) => {
      understanding += 1;
      if (understanding === 1) return { kind: 'clarify', question: '请提供需要总结的文件路径。' };
      assert.ok(JSON.stringify(modelRequest).includes('请提供需要总结的文件路径。'));
      return { kind: 'file', task: { sourcePath: 'input.txt' }, instruction: '总结文件中的主要信息。' };
    },
  });
  f.runtime.enqueue(request('总结一份文件'));
  await settle(f.runtime);
  f.runtime.enqueue(request('input.txt'));
  const snapshot = await settle(f.runtime, 2);
  assert.equal(snapshot.result.status, 'completed');
  assert.deepEqual(snapshot.task, { kind: 'file', task: { sourcePath: 'input.txt' } });
  assert.equal(snapshot.fileOutput, undefined);
  assert.equal(f.calls.filter((call) => call.purpose === 'answer').length, 1);
  assert.equal(f.environment.transcript.length, 4);
});
