import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationRunner, createConversationScene, HistoryResource, ModelResource } from '@capix/conversation-service';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/transcript';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('conversation assembly returns the native Runner and carries accepted history across runs', async () => {
  const transcript = new Transcript();
  const model = {
    requests: [],
    generate(messages) {
      this.requests.push(messages);
      assert.equal(Object.isFrozen(messages), true);
      assert.ok(messages.every(Object.isFrozen));
      return `reply ${this.requests.length}`;
    },
  };
  const runner = createConversationRunner(transcript, model);

  assert.ok(runner instanceof Runner);
  assert.equal(await runner.run('  first question\n'), 'reply 1');
  assert.equal(await runner.run('second question'), 'reply 2');
  assert.deepEqual(model.requests, [
    [{ role: 'user', content: '  first question\n' }],
    [
      { role: 'user', content: '  first question\n' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'second question' },
    ],
  ]);
  assert.deepEqual(transcript.snapshot(), [...model.requests[1], { role: 'assistant', content: 'reply 2' }]);
  assert.equal(runner.isRunning, false);
});

test('the public scene and offers also assemble through ordinary Resources and Runner', async () => {
  const transcript = new Transcript([{ role: 'user', content: 'earlier question' }]);
  const messages = new Resource(transcript);
  const resources = new Resources()
    .register(messages, TranscriptResource.append)
    .register(messages, HistoryResource)
    .register(new Resource({ generate: (history) => `read ${history.length} messages` }), ModelResource);
  const runner = new Runner(createConversationScene(), resources).build();

  assert.equal(await runner.run('current question'), 'read 2 messages');
  assert.deepEqual(transcript.snapshot(), [
    { role: 'user', content: 'earlier question' },
    { role: 'user', content: 'current question' },
    { role: 'assistant', content: 'read 2 messages' },
  ]);
});

test('invalid conversation input produces no message, model request or persistence write', async () => {
  const writes = [];
  const events = [];
  const transcript = new Transcript([], {
    persistence: { commit: (change) => void writes.push(change) },
    changes: { capture: (event) => void events.push(event) },
  });
  let requests = 0;
  const runner = createConversationRunner(transcript, {
    generate() {
      requests++;
      return 'answer';
    },
  });

  for (const input of ['', ' \n\t', undefined, null, 7, { text: 'question' }]) {
    await assert.rejects(runner.run(input));
    assert.equal(runner.isRunning, false);
  }
  assert.equal(requests, 0);
  assert.equal(transcript.length, 0);
  assert.equal(transcript.revision, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(events, []);
  assert.equal(await runner.run('valid question'), 'answer');
});

test('model failure and invalid output preserve the input and allow a later successful run', async (t) => {
  for (const [label, respond] of [
    ['rejection', () => Promise.reject(new Error('provider unavailable'))],
    ['empty answer', () => ''],
    ['blank answer', () => ' \n\t'],
    ['missing answer', () => undefined],
    ['non-text answer', () => ({ text: 'not a string' })],
  ]) {
    await t.test(label, async () => {
      const transcript = new Transcript();
      const requests = [];
      const runner = createConversationRunner(transcript, {
        generate(messages) {
          requests.push(messages);
          return requests.length === 1 ? respond() : '  recovered answer\n';
        },
      });

      await assert.rejects(runner.run('first input'));
      assert.equal(runner.isRunning, false);
      assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'first input' }]);
      assert.equal(await runner.run('retry input'), '  recovered answer\n');
      assert.deepEqual(requests[1], [
        { role: 'user', content: 'first input' },
        { role: 'user', content: 'retry input' },
      ]);
      assert.deepEqual(transcript.snapshot(), [...requests[1], { role: 'assistant', content: '  recovered answer\n' }]);
    });
  }
});

test('busy rejection neither appends the rejected input nor replaces the active call', { timeout: 5000 }, async () => {
  const entered = deferred();
  const response = deferred();
  const transcript = new Transcript();
  let requests = 0;
  const runner = createConversationRunner(transcript, {
    generate() {
      requests++;
      entered.resolve();
      return response.promise;
    },
  });
  const first = runner.run('first');
  await entered.promise;

  await assert.rejects(runner.run('second'), (error) => error.code === 'RUNTIME_BUSY');
  assert.equal(runner.isRunning, true);
  assert.equal(requests, 1);
  assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'first' }]);
  response.resolve('completed');
  assert.equal(await first, 'completed');
  assert.equal(runner.isRunning, false);
  assert.deepEqual(transcript.snapshot(), [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'completed' },
  ]);
});

test('cancellation rejects a late model result before message acceptance and releases the Runner', { timeout: 5000 }, async () => {
  const entered = deferred();
  const response = deferred();
  const controller = new AbortController();
  const transcript = new Transcript();
  let modelSignal;
  let requests = 0;
  const runner = createConversationRunner(transcript, {
    generate(_messages, { signal }) {
      requests++;
      if (requests > 1) return 'next answer';
      modelSignal = signal;
      entered.resolve();
      // This provider deliberately does not stop when its signal aborts.
      return response.promise;
    },
  });
  const active = runner.run('cancelled input', { signal: controller.signal });
  const rejected = assert.rejects(active);
  await entered.promise;
  assert.ok(modelSignal instanceof AbortSignal);
  assert.equal(modelSignal.aborted, false);
  controller.abort(new Error('caller stopped waiting'));
  assert.equal(modelSignal.aborted, true);
  response.resolve('late answer');
  await rejected;

  assert.equal(runner.isRunning, false);
  assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'cancelled input' }]);
  assert.equal(await runner.run('next input'), 'next answer');
  assert.deepEqual(transcript.snapshot(), [
    { role: 'user', content: 'cancelled input' },
    { role: 'user', content: 'next input' },
    { role: 'assistant', content: 'next answer' },
  ]);
});

test('independent conversation assemblies do not share structures, occupancy or history', { timeout: 5000 }, async () => {
  const firstTranscript = new Transcript();
  const secondTranscript = new Transcript();
  const entered = deferred();
  const response = deferred();
  const first = createConversationRunner(firstTranscript, {
    generate() {
      entered.resolve();
      return response.promise;
    },
  });
  const second = createConversationRunner(secondTranscript, {
    generate(messages) {
      assert.deepEqual(messages, [{ role: 'user', content: 'second input' }]);
      return 'second answer';
    },
  });
  assert.notEqual(first.scene, second.scene);
  const firstRun = first.run('first input');
  await entered.promise;
  assert.equal(await second.run('second input'), 'second answer');
  assert.equal(first.isRunning, true);
  assert.equal(second.isRunning, false);
  response.resolve('first answer');
  assert.equal(await firstRun, 'first answer');
  assert.deepEqual(firstTranscript.snapshot(), [
    { role: 'user', content: 'first input' },
    { role: 'assistant', content: 'first answer' },
  ]);
  assert.deepEqual(secondTranscript.snapshot(), [
    { role: 'user', content: 'second input' },
    { role: 'assistant', content: 'second answer' },
  ]);
});

test('an isolated optional observer failure does not change the conversation result', async () => {
  const transcript = new Transcript();
  let observations = 0;
  const runner = createConversationRunner(
    transcript,
    { generate: () => 'answer' },
    {
      observations: [
        {
          failure: 'isolate',
          bindInvocation() {
            return {
              observe() {
                observations++;
                throw new Error('observer unavailable');
              },
            };
          },
        },
      ],
    },
  );

  assert.equal(await runner.run('question'), 'answer');
  assert.ok(observations > 0);
  assert.deepEqual(transcript.snapshot(), [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  ]);
  assert.equal(runner.isRunning, false);
});

test('failed assistant persistence cannot publish a formal answer or report success', async () => {
  const events = [];
  const committed = [];
  let rejectAnswer = true;
  const transcript = new Transcript([], {
    changes: { capture: (event) => void events.push(event) },
    persistence: {
      commit(change) {
        if (rejectAnswer && change.kind === 'append' && change.messages.some((message) => message.role === 'assistant')) throw new Error('storage unavailable');
        committed.push(change);
      },
    },
  });
  const runner = createConversationRunner(transcript, { generate: () => 'answer' });

  await assert.rejects(runner.run('first input'));
  assert.equal(runner.isRunning, false);
  assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'first input' }]);
  assert.equal(committed.length, 1);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].change.messages, [{ role: 'user', content: 'first input' }]);

  rejectAnswer = false;
  assert.equal(await runner.run('next input'), 'answer');
  assert.equal(committed.length, 3);
  assert.equal(events.length, 3);
  assert.deepEqual(transcript.snapshot(), [
    { role: 'user', content: 'first input' },
    { role: 'user', content: 'next input' },
    { role: 'assistant', content: 'answer' },
  ]);
});

test('failed input persistence prevents both the model call and formal input publication', async () => {
  const events = [];
  const transcript = new Transcript([], {
    changes: { capture: (event) => void events.push(event) },
    persistence: {
      commit() {
        throw new Error('storage unavailable');
      },
    },
  });
  let requests = 0;
  const runner = createConversationRunner(transcript, {
    generate() {
      requests++;
      return 'answer';
    },
  });

  await assert.rejects(runner.run('question'));
  assert.equal(requests, 0);
  assert.equal(transcript.length, 0);
  assert.equal(transcript.revision, 0);
  assert.deepEqual(events, []);
  assert.equal(runner.isRunning, false);
});
