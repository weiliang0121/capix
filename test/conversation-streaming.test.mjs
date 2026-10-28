import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationRunner } from '@capix/conversation-service';
import { Transcript } from '@capix/transcript';

const collect = (events) => ({ receive: (event) => void events.push(event) });
const deltas = (events) => events.filter((event) => event.kind === 'delta').map((event) => event.delta);

test('conversation forwards model chunks in order while only the complete answer becomes a message', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const response = Promise.withResolvers();
  const transcript = new Transcript();
  const events = [];
  const runner = createConversationRunner(transcript, {
    generate(_messages, { emit }) {
      emit('hello');
      emit(' ');
      emit('');
      emit('world');
      entered.resolve();
      return response.promise;
    },
  });
  runner.output.subscribe(collect(events));
  const result = runner.run('question');
  await entered.promise;

  assert.deepEqual(deltas(events), ['hello', ' ', '', 'world']);
  assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'question' }]);
  assert.equal(
    events.some((event) => event.kind === 'completed'),
    false,
  );
  response.resolve('hello world');
  assert.equal(await result, 'hello world');
  assert.equal(events.at(-1).kind, 'completed');
  assert.equal(events.at(-1).result, 'hello world');
  assert.deepEqual(transcript.snapshot(), [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'hello world' },
  ]);
});

test('final text is authoritative and may differ from the streamed preview', async () => {
  const transcript = new Transcript();
  const events = [];
  const runner = createConversationRunner(transcript, {
    generate(_messages, { emit }) {
      emit('a preliminary answer');
      return '  corrected final answer\n';
    },
  });
  runner.output.subscribe(collect(events));

  assert.equal(await runner.run('question'), '  corrected final answer\n');
  assert.deepEqual(deltas(events), ['a preliminary answer']);
  assert.equal(events.at(-1).result, '  corrected final answer\n');
  assert.deepEqual(transcript.snapshot(), [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: '  corrected final answer\n' },
  ]);
});

test('non-text model chunks fail even when no output subscriber exists', async (t) => {
  for (const invalid of [42, null, { text: 'not a string' }]) {
    await t.test(JSON.stringify(invalid), async () => {
      const transcript = new Transcript();
      let first = true;
      const runner = createConversationRunner(transcript, {
        generate(_messages, { emit }) {
          if (first) {
            first = false;
            emit(invalid);
          }
          return 'answer';
        },
      });
      await assert.rejects(runner.run('first'));
      assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'first' }]);
      assert.equal(runner.isRunning, false);
      assert.equal(await runner.run('second'), 'answer');
    });
  }
});

test('preview delivery cannot validate a blank final model answer', async () => {
  const transcript = new Transcript();
  const events = [];
  const runner = createConversationRunner(transcript, {
    generate(_messages, { emit }) {
      emit('plausible preview');
      return ' \n';
    },
  });
  runner.output.subscribe(collect(events));

  await assert.rejects(runner.run('question'));
  assert.deepEqual(deltas(events), ['plausible preview']);
  assert.equal(events.at(-1).kind, 'discarded');
  assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'question' }]);
});

test('model failure after preview does not publish an assistant message or completed output', async () => {
  const transcript = new Transcript();
  const events = [];
  const runner = createConversationRunner(transcript, {
    async generate(_messages, { emit }) {
      emit('partial answer');
      throw new Error('model connection failed');
    },
  });
  runner.output.subscribe(collect(events));

  await assert.rejects(runner.run('question'));
  assert.deepEqual(deltas(events), ['partial answer']);
  assert.equal(
    events.some((event) => event.kind === 'completed'),
    false,
  );
  assert.equal(events.at(-1).kind, 'discarded');
  assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'question' }]);
});

test('cancellation rejects late model chunks and the late result without appending an assistant message', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const response = Promise.withResolvers();
  const transcript = new Transcript();
  const events = [];
  let lateEmit;
  let first = true;
  const runner = createConversationRunner(transcript, {
    generate(_messages, { emit }) {
      if (!first) return 'next answer';
      first = false;
      lateEmit = emit;
      emit('partial');
      entered.resolve();
      return response.promise;
    },
  });
  runner.output.subscribe(collect(events));
  const active = runner.run('cancelled question');
  const rejected = assert.rejects(active);
  await entered.promise;
  assert.equal(runner.cancel(), true);
  assert.throws(() => lateEmit('after cancellation'));
  assert.deepEqual(deltas(events), ['partial']);
  assert.equal(runner.isRunning, true, 'an uncooperative direct model still owns its in-flight operation');
  response.resolve('late answer');
  await rejected;
  assert.equal(runner.isRunning, false);
  assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'cancelled question' }]);
  assert.throws(() => lateEmit('after operation close'));

  assert.equal(await runner.run('next question'), 'next answer');
  assert.deepEqual(transcript.snapshot(), [
    { role: 'user', content: 'cancelled question' },
    { role: 'user', content: 'next question' },
    { role: 'assistant', content: 'next answer' },
  ]);
});

test('a retained model emitter cannot publish after successful operation completion', async () => {
  const transcript = new Transcript();
  const events = [];
  let emit;
  const runner = createConversationRunner(transcript, {
    generate(_messages, controls) {
      emit = controls.emit;
      emit('preview');
      return 'answer';
    },
  });
  runner.output.subscribe(collect(events));
  assert.equal(await runner.run('question'), 'answer');
  const count = events.length;
  assert.throws(() => emit('late'));
  assert.equal(events.length, count);
  assert.equal(transcript.snapshot().at(-1).content, 'answer');
});

test('a cooperative direct model preserves exact cancellation through its signal rejection', { timeout: 5000 }, async () => {
  for (const external of [false, true]) {
    const entered = Promise.withResolvers();
    const controller = new AbortController();
    const transcript = new Transcript();
    const observations = [];
    const runner = createConversationRunner(transcript, {
      generate(_messages, { signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          entered.resolve();
        });
      },
    });
    runner.observation.subscribe(collect(observations));
    const running = runner.run('question', external ? { signal: controller.signal } : {});
    const rejected = assert.rejects(running, { code: 'INVOCATION_CANCELLED' });
    await entered.promise;
    const reason = new Error('stop this request');
    if (external) controller.abort(reason);
    else runner.cancel(reason);
    await rejected;
    assert.equal(runner.isRunning, false);
    assert.equal(observations.findLast((event) => event.source === 'entry' && event.fact.kind === 'settled').fact.status, 'cancelled');
    assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'question' }]);
  }
});

test('a distinct model failure concurrent with cancellation remains failed rather than cancelled', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const fault = new Error('provider failed independently');
  const transcript = new Transcript();
  const observations = [];
  const runner = createConversationRunner(transcript, {
    generate(_messages, { signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(fault), { once: true });
        entered.resolve();
      });
    },
  });
  runner.observation.subscribe(collect(observations));
  const running = runner.run('question');
  const rejected = assert.rejects(running, (error) => error instanceof AggregateError && error.errors.includes(fault));
  await entered.promise;
  runner.cancel(new Error('separate cancellation'));
  await rejected;
  assert.equal(runner.isRunning, false);
  assert.equal(observations.findLast((event) => event.source === 'entry' && event.fact.kind === 'settled').fact.status, 'failed');
  assert.deepEqual(transcript.snapshot(), [{ role: 'user', content: 'question' }]);
});

test('a failed output consumer does not stop model streaming or formal answer acceptance', async () => {
  const transcript = new Transcript();
  const events = [];
  let reports = 0;
  const runner = createConversationRunner(transcript, {
    generate(_messages, { emit }) {
      emit('first');
      emit('second');
      return 'answer';
    },
  });
  runner.output.subscribe({
    receive(event) {
      if (event.kind === 'delta') throw new Error('viewer unavailable');
    },
    failed() {
      reports++;
    },
  });
  runner.output.subscribe(collect(events));

  assert.equal(await runner.run('question'), 'answer');
  assert.equal(reports, 1);
  assert.deepEqual(deltas(events), ['first', 'second']);
  assert.equal(events.at(-1).kind, 'completed');
  assert.equal(transcript.snapshot().at(-1).content, 'answer');
});
