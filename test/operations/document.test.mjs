import { createConversationRunner } from '../fixtures/conversation-runner.mjs';
import { ActiveView } from '@capix/observer-content';
import { ModelInteractions, ModelSource } from '@capix/observer-service';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationStructure, ConversationSubmission, WorkspaceFiles } from '@capix/observer-service';
import { ProgressChannel } from '@capix/changes';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { MessageUsage } from '@capix/measurement';
import { bindRecording } from '@capix/server-runtime/recording';
import { Recorder, RecordBook } from '@capix/records';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const sourceText = 'PRIVATE_SOURCE_MARKER 文档中的资料，不应进入记录正文。';
const answer = { kind: 'answer', content: '文档总结结果。' };
const modelOutput = (value) => ({ id: 'fixture', model: 'fixture', content: typeof value === 'string' ? value : JSON.stringify(value), finishReason: 'stop', usage: null });

async function fixture(t, { recorded = true, answers = [answer], memoryFailure = false, recordingFailure = 'isolate' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'capix-document-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.txt'), sourceText);
  const files = new WorkspaceFiles({ root });
  const calls = [];
  let reads = 0;
  let writes = 0;
  const read = files.readText.bind(files);
  files.readText = (...args) => {
    reads += 1;
    return read(...args);
  };
  const create = files.createText.bind(files);
  files.createText = (...args) => {
    writes += 1;
    return create(...args);
  };
  const provider = {
    async invoke(request, purpose) {
      calls.push({ request, purpose });
      if (purpose === 'selection') return modelOutput({ historyIndexes: [] });
      if (purpose === 'understanding') return modelOutput({ kind: 'reply' });
      if (purpose === 'memory') return modelOutput(memoryFailure ? 'invalid' : { memories: [] });
      return modelOutput(answers.shift() ?? answer);
    },
  };
  const recorder = recorded ? new Recorder(new RecordBook()) : undefined;
  const recording = recorder ? bindRecording(recorder, { failure: recordingFailure }) : undefined;
  const transcript = new Transcript([], { observation: recording?.transcript });
  const memories = new Memories(transcript, { observation: recording?.memory });
  const entities = { transcript, memories, active: new ActiveView(transcript, memories), files, messageUsage: new MessageUsage() };
  const definition = createConversationStructure({ files: true });

  const runner = createConversationRunner(definition, entities, new ModelInteractions(new ModelSource(provider)), { observations: recording ? [recording] : undefined });
  const progress = [];
  const fileProgress = new ProgressChannel({
    receive(fact) {
      progress.push(fact);
    },
  });
  let invocation;
  return {
    root,
    files,
    calls,
    transcript,
    recorder,
    progress,
    runner,
    scene: runner.scene,
    counts: () => ({ reads, writes }),
    invocation: () => invocation,
    run: (fileTask = { sourcePath: 'source.txt', output: { path: 'summary.txt' } }, options = {}) =>
      runner.run(
        { messages: [{ role: 'user', content: '请总结这份文档' }], ...(fileTask ? { fileTask } : {}) },
        {
          settings,
          fileProgress,
          executionCallbacks: {
            started: (_context, current) => {
              invocation = current;
            },
          },
          ...options,
        },
      ),
  };
}

for (const recorded of [true, false]) {
  test(`document read, generation and create use the same E with recording ${recorded}`, async (t) => {
    const f = await fixture(t, { recorded });
    assert.deepEqual(await f.run(), answer);
    assert.equal(await readFile(join(f.root, 'summary.txt'), 'utf8'), answer.content);
    assert.deepEqual(f.counts(), { reads: 1, writes: 1 });
    assert.deepEqual(
      f.progress.map((fact) => fact.kind),
      ['requested', 'started', 'created'],
    );
    assert.deepEqual(
      f.calls.map((call) => call.purpose),
      ['answer', 'memory'],
    );
    assert.ok(f.calls[0].request.messages.some((message) => message.content.includes(sourceText)));
    assert.equal(f.transcript.length, 2);
    assert.equal(f.transcript.get(1).content, answer.content);
    const children = f.invocation().children.values();
    assert.deepEqual(
      children.map((child) => child.key),
      ['preparation', 'decision', 'preflight', 'decision', 'generation', 'decision', 'save', 'decision', 'extraction'],
    );
    assert.deepEqual(
      children
        .find((child) => child.key === 'generation')
        .invocation.children.values()
        .map((child) => child.key),
      ['read', 'generation'],
    );
    if (f.recorder) assert.equal(JSON.stringify([...f.recorder.book.values()].map((record) => record.toJSON())).includes(sourceText), false);
  });
}

test('ordinary conversation with file capability configured performs no file IO', async (t) => {
  const f = await fixture(t);
  await f.run(null);
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
  assert.deepEqual(f.progress, []);
});

test('model output regeneration reuses read evidence and creates only once', async (t) => {
  const f = await fixture(t, { answers: ['invalid', answer] });
  await f.run();
  assert.deepEqual(f.counts(), { reads: 1, writes: 1 });
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['answer', 'answer', 'memory'],
  );
  assert.equal(JSON.stringify([...f.recorder.book.values()].map((record) => record.toJSON())).includes(sourceText), false);
});

for (const kind of ['needs-info', 'unknown']) {
  test(`${kind} answers never create the requested output`, async (t) => {
    const f = await fixture(t, { answers: [{ kind, content: '需要进一步说明。' }] });
    assert.equal((await f.run()).kind, kind);
    assert.deepEqual(f.counts(), { reads: 1, writes: 0 });
    assert.deepEqual(
      f.progress.map((fact) => fact.kind),
      ['requested'],
    );
    await assert.rejects(access(join(f.root, 'summary.txt')));
  });
}

test('malformed file tasks fail before accepting transcript input or reading files', async (t) => {
  const f = await fixture(t);
  for (const fileTask of [null, {}, { sourcePath: '../source.txt' }, { sourcePath: 'source.txt', output: { path: 'source.txt' } }, { sourcePath: 'source.txt', output: { path: '/outside' } }, { sourcePath: 'source.txt', unknown: true }]) {
    await assert.rejects(f.runner.run({ messages: [{ role: 'user', content: 'bad' }], fileTask }, { settings }), (error) => error.code === 'INVALID_INPUT' || error.cause?.code === 'INVALID_INPUT');
  }
  assert.equal(f.transcript.length, 0);
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
});

test('disabled file capability rejects before accepting input', async () => {
  const transcript = new Transcript();
  const memories = new Memories(transcript);

  const runner = createConversationRunner(
    createConversationStructure(),
    { transcript, memories, active: new ActiveView(transcript, memories), messageUsage: new MessageUsage() },
    new ModelInteractions(
      new ModelSource(() => {
        throw new Error('must not initialize provider');
      }),
    ),
  );
  await assert.rejects(runner.run({ messages: [{ role: 'user', content: 'hello' }], fileTask: { sourcePath: 'source.txt' } }, { settings }));
  assert.equal(transcript.length, 0);
});

test('a missing source is clarified before read and releases the runtime for a later conversation', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run({ sourcePath: 'missing.txt' })).kind, 'needs-info');
  assert.equal(f.transcript.length, 2);
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
  await f.run(null);
  assert.equal(f.transcript.length, 4);
});

test('existing output is detected before generation without attempting overwrite', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'summary.txt'), 'keep');
  assert.equal((await f.run()).kind, 'needs-info');
  assert.equal(await readFile(join(f.root, 'summary.txt'), 'utf8'), 'keep');
  assert.equal(f.transcript.length, 2);
  assert.ok(f.transcript.get(1).content.includes('已存在'));
  assert.deepEqual(f.progress, []);
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
  assert.equal(
    f.calls.some((call) => call.purpose === 'answer'),
    false,
  );
});

test('post-answer memory failure preserves file publication and assistant body', async (t) => {
  const f = await fixture(t, { memoryFailure: true });
  await assert.rejects(f.run());
  assert.equal(await readFile(join(f.root, 'summary.txt'), 'utf8'), answer.content);
  assert.equal(f.transcript.length, 2);
  assert.equal(f.progress.at(-1).kind, 'created');
});

test('cancellation immediately after confirmed publication preserves file fact before A returns', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const facts = [];
  const fileProgress = new ProgressChannel({
    receive(fact) {
      facts.push(fact);
      if (fact.kind === 'created') controller.abort();
    },
  });
  await assert.rejects(f.run(undefined, { signal: controller.signal, fileProgress }));
  assert.equal(await readFile(join(f.root, 'summary.txt'), 'utf8'), answer.content);
  assert.equal(f.transcript.length, 2);
  assert.equal(facts.at(-1).kind, 'created');
});

test('declared file support requires the bound workspace entity', () => {
  const transcript = new Transcript();
  const memories = new Memories(transcript);
  assert.throws(
    () =>
      createConversationRunner(
        createConversationStructure({ files: true }),
        { transcript, memories, active: new ActiveView(transcript, memories), messageUsage: new MessageUsage() },
        new ModelInteractions(
          new ModelSource(() => {
            throw new Error('unused');
          }),
        ),
      ),
    /workspace file entity/,
  );
});

test('read-only document processing has no file output request', async (t) => {
  const f = await fixture(t);
  await f.run({ sourcePath: 'source.txt' });
  assert.deepEqual(f.counts(), { reads: 1, writes: 0 });
  assert.deepEqual(f.progress, []);
});

test('record consumer failure after publication cannot erase or repeat the committed file', async (t) => {
  const f = await fixture(t, { recordingFailure: 'propagate' });
  const add = f.recorder.add.bind(f.recorder);
  t.mock.method(f.recorder, 'add', (record) => {
    if (record.kind === 'resource' && record.access === 'workspace-files.create-text' && record.phase === 'returned') throw new Error('record output unavailable');
    return add(record);
  });
  await assert.rejects(f.run());
  assert.equal(await readFile(join(f.root, 'summary.txt'), 'utf8'), answer.content);
  assert.equal(f.transcript.length, 2);
  assert.equal(f.progress.at(-1).kind, 'created');
  assert.deepEqual(f.counts(), { reads: 1, writes: 1 });
});

for (const interruption of ['cancel-after-input', 'started-callback-fault']) {
  test(`${interruption} before task selection has no invented file execution fact`, async (t) => {
    const f = await fixture(t);
    const submission = new ConversationSubmission(interruption);
    const progress = new ProgressChannel({
      receive(fact) {
        submission.progress.publish(fact);
        if (interruption === 'cancel-after-input' && fact.kind === 'input') submission.requestCancellation();
      },
    });
    const terminal = new Promise((resolve) => {
      let disconnect = () => {};
      disconnect = submission.connect((snapshot) => {
        if (snapshot.result) {
          disconnect();
          resolve(snapshot);
        }
      });
    });
    submission.start((signal) =>
      f.run(undefined, {
        signal,
        progress,
        fileProgress: submission.fileProgress,
        executionCallbacks: {
          started() {
            if (interruption === 'started-callback-fault') throw new Error('binding callback failed');
          },
        },
      }),
    );
    const snapshot = await terminal;
    assert.equal(snapshot.task, undefined);
    assert.equal(snapshot.fileOutput, undefined);
    assert.equal(snapshot.result.status, interruption === 'cancel-after-input' ? 'cancelled' : 'failed');
    assert.equal(f.transcript.length, 1);
    assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
  });
}
