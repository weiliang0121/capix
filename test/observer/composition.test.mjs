import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver } from '@capix-observer/service';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const answer = { kind: 'answer', content: '这是回答。' };

async function execute(failAt) {
  const calls = [];
  const environment = initializeObserver(
    {
      async invoke(_request, purpose) {
        calls.push(purpose);
        const content = purpose === failAt ? 'invalid JSON' : JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? answer : { memories: [] });
        return { id: 'fixture', model: 'fixture', content, finishReason: 'stop', usage: null };
      },
    },
    [{ role: 'user', content: '你好' }],
  );
  let invocation;
  let error;
  try {
    await environment.execution.call(environment.transcript.current('user'), { settings, transcript: environment.transcript }, (_context, current) => {
      invocation = current;
    });
  } catch (failure) {
    error = failure;
  }
  return { environment, invocation, error, calls };
}

test('Observer retains its E/O/A composition without additional execution records', async () => {
  const { invocation, error, calls, environment } = await execute();
  assert.equal(error, undefined);
  assert.deepEqual(calls, ['selection', 'answer', 'memory']);
  const children = invocation.children.values();
  assert.deepEqual(
    children.map((child) => child.key),
    ['selection', 'generation', 'extraction'],
  );
  assert.deepEqual(
    children.map((child) => child.reception.status),
    ['accepted', 'accepted', 'accepted'],
  );
  assert.deepEqual(
    children[1].invocation.children.values().map((child) => child.key),
    ['context', 'request', 'model', 'acceptance'],
  );
  assert.deepEqual(children[1].returned.output, answer);
  assert.equal(children[1].reception.output.response.message, environment.transcript.get(1));
  assert.deepEqual(invocation.context.state.output, answer);
});

test('memory failure preserves the delivered answer and completed generation relationship', async () => {
  const { invocation, environment, error, calls } = await execute('memory');
  assert.equal(error.code, 'INVALID_JSON');
  assert.deepEqual(calls, ['selection', 'answer', 'memory']);
  assert.equal(environment.transcript.length, 2);
  assert.equal(environment.transcript.get(1).content, answer.content);
  const children = invocation.children.values();
  assert.equal(children[1].invocation.context.status, 'succeeded');
  assert.equal(children[1].reception.status, 'accepted');
  assert.equal(children[2].returned.status, 'failed');
  assert.deepEqual(
    children[2].invocation.children.values().map((child) => child.key),
    ['request', 'model', 'acceptance'],
  );
});

test('invalid model output stays available through the actual child invocation without querying records', async () => {
  const { invocation, error, calls, environment } = await execute('answer');
  assert.equal(error.code, 'INVALID_JSON');
  assert.deepEqual(calls, ['selection', 'answer', 'answer']);
  assert.equal(environment.transcript.length, 1);
  const children = invocation.children.values();
  assert.equal(children.length, 2);
  const generation = children[1].invocation.children.values();
  assert.equal(generation[2].returned.output.content, 'invalid JSON');
  assert.equal(generation[2].reception.status, 'accepted');
  assert.equal(generation[3].returned.error.code, 'INVALID_JSON');
  assert.equal(generation[6].returned.error, error);
  assert.notEqual(generation[3].invocation.context, generation[6].invocation.context);
});
