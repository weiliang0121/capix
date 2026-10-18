import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver } from '@capix/observer-service/assembly';

const settings = { model: 'fixture', contextBudget: 100000, maxOutputTokens: 512, timeoutMs: 1000 };
const input = (content) => ({ messages: [{ role: 'user', content }] });
const history = [
  { role: 'user', content: 'older question' },
  { role: 'assistant', content: 'older answer' },
];
const feedback = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
function setup(t, options = {}, onRequest) {
  const requests = [];
  const environment = initializeObserver(
    {
      async invoke(request, purpose) {
        requests.push({ purpose, body: JSON.parse(request.messages[1].content) });
        onRequest?.(purpose, environment);
        return feedback(purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: 'fixed answer' });
      },
    },
    history,
    options,
  );
  t.after(() => environment.close());
  return { environment, requests };
}

test('active material alone supplies the default request and memory extraction keeps the same fixed values', async (t) => {
  let memory;
  const { environment, requests } = setup(t, {}, (purpose, env) => {
    if (purpose === 'answer') env.memories.apply([{ action: 'update', memoryId: memory.id, result: { topic: 'topic', content: 'new content', sourceIndexes: [0] }, change: 'updated after capture', sourceIndexes: [0] }]);
  });
  [memory] = environment.memories.apply([{ action: 'create', memoryId: null, result: { topic: 'topic', content: 'fixed content', sourceIndexes: [0] }, change: 'initial', sourceIndexes: [0] }]);
  const active = environment.content.active.capture();
  environment.content.active.apply({ basis: active.basis, messageIndexes: [1, 0], memoryIds: [memory.id] });
  await environment.runtime.run(input('continue'), { settings });
  assert.deepEqual(
    requests.map((request) => request.purpose),
    ['answer', 'memory'],
  );
  assert.deepEqual(
    requests[0].body.history.map((item) => item.index),
    [1, 0],
  );
  assert.equal(requests[0].body.memories[0].content, 'fixed content');
  assert.equal(requests[1].body.memories[0].content, 'fixed content');
  assert.deepEqual(
    requests[1].body.messages.map((item) => item.index),
    [1, 0, 2, 3],
  );
  assert.equal(environment.memories.get(memory.id).content, 'new content');
  assert.equal(environment.transcript.activeStart, 0);
});

test('configured maintenance runs as normal O before capture and once after content, without deleting formal messages', async (t) => {
  const phases = [];
  const { environment, requests } = setup(t, {
    maintenance({ phase, material }) {
      phases.push(phase);
      return { basis: material.basis, messageIndexes: phase === 'before-request' ? [1] : [], memoryIds: [] };
    },
  });
  await environment.runtime.run(input('continue'), { settings });
  assert.deepEqual(phases, ['before-request', 'after-content']);
  assert.deepEqual(
    requests[0].body.history.map((item) => item.index),
    [1],
  );
  assert.deepEqual(environment.content.active.capture().messages, []);
  assert.equal(environment.transcript.length, 4);
  const records = [...environment.book.values()];
  const maintenance = records.filter((record) => record.operation === 'maintainContext');
  assert.equal(maintenance.length, 2);
  assert.ok(maintenance.every((record) => record.status === 'succeeded'));
});

test('maintenance failure preserves formal input, releases R and permits a new submission', async (t) => {
  let fail = true;
  const { environment, requests } = setup(t, {
    maintenance({ material }) {
      if (fail) throw new Error('maintenance failed');
      return { basis: material.basis, messageIndexes: material.messages.map((item) => item.index), memoryIds: [] };
    },
  });
  await assert.rejects(environment.runtime.run(input('first'), { settings }), /maintenance failed/);
  assert.equal(environment.transcript.length, 3);
  assert.equal(requests.length, 0);
  assert.equal(environment.runtime.running, false);
  fail = false;
  await environment.runtime.run(input('second'), { settings });
  assert.equal(environment.transcript.length, 5);
  assert.deepEqual(
    requests.map((request) => request.purpose),
    ['answer', 'memory'],
  );
});

test('after-content failure preserves the answer and does not recursively retry maintenance', async (t) => {
  const phases = [];
  const { environment } = setup(t, {
    maintenance({ phase, material }) {
      phases.push(phase);
      if (phase === 'after-content') throw new Error('postprocess failed');
      return { basis: material.basis, messageIndexes: material.messages.map((item) => item.index), memoryIds: [] };
    },
  });
  await assert.rejects(environment.runtime.run(input('continue'), { settings }), /postprocess failed/);
  assert.deepEqual(phases, ['before-request', 'after-content']);
  assert.equal(environment.transcript.get(3).content, 'fixed answer');
  assert.equal(environment.runtime.running, false);
});

test('R occupancy rejects a competing submission before it can append input during maintenance', async (t) => {
  let release;
  let entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const { environment } = setup(t, {
    async maintenance({ phase, material }) {
      if (phase === 'before-request') {
        entered();
        await waiting;
      }
      return { basis: material.basis, messageIndexes: material.messages.map((item) => item.index), memoryIds: [] };
    },
  });
  const first = environment.runtime.run(input('first'), { settings });
  await started;
  await assert.rejects(environment.runtime.run(input('second'), { settings }), { code: 'RUNTIME_BUSY' });
  assert.equal(environment.transcript.length, 3);
  release();
  await first;
});
