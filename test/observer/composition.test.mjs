import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver } from '@capix-observer/service';
import { DeclaredException } from '@capix-observer/runtime';

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
    [],
  );
  let invocation;
  let error;
  try {
    await environment.runtime.run(
      { messages: [{ role: 'user', content: '你好' }] },
      {
        settings,
        execution: {
          started: (_context, current) => {
            invocation = current;
          },
        },
      },
    );
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
  assert.equal(error.code, 'UNHANDLED_EXCEPTION');
  assert.ok(error.cause instanceof DeclaredException);
  assert.equal(error.cause.code, 'MODEL_OUTPUT_REJECTED');
  assert.equal(error.cause.cause.code, 'INVALID_JSON');
  assert.equal(error.cause.facts.code, 'INVALID_JSON');
  assert.deepEqual(calls, ['selection', 'answer', 'memory']);
  assert.equal(environment.transcript.length, 2);
  assert.equal(environment.transcript.get(1).content, answer.content);
  const children = invocation.children.values();
  assert.equal(children[1].invocation.context.status, 'succeeded');
  assert.equal(children[1].reception.status, 'accepted');
  assert.equal(children[2].returned.status, 'failed');
  assert.equal(children[2].returned.error, error.cause);
  assert.equal(children[2].invocation.failure.kind, 'exception');
  const extraction = children[2].invocation.children.values();
  assert.equal(error.cause.facts.output, extraction[1].returned.output);
  assert.equal(error.cause.facts.output.content, 'invalid JSON');
  assert.equal(extraction[2].returned.error, error.cause);
  assert.deepEqual(
    children[2].invocation.children.values().map((child) => child.key),
    ['request', 'model', 'acceptance'],
  );
});

test('invalid model output stays available through the actual child invocation without querying records', async () => {
  const { invocation, error, calls, environment } = await execute('answer');
  assert.equal(error.code, 'UNHANDLED_EXCEPTION');
  assert.ok(error.cause instanceof DeclaredException);
  assert.deepEqual(calls, ['selection', 'answer', 'answer']);
  assert.equal(environment.transcript.length, 1);
  const children = invocation.children.values();
  assert.equal(children.length, 2);
  const generation = children[1].invocation.children.values();
  assert.equal(generation[2].returned.output.content, 'invalid JSON');
  assert.equal(generation[2].reception.status, 'accepted');
  for (const [model, acceptance] of [
    [generation[2], generation[3]],
    [generation[5], generation[6]],
  ]) {
    const rejection = acceptance.returned.error;
    assert.ok(rejection instanceof DeclaredException);
    assert.equal(rejection.code, 'MODEL_OUTPUT_REJECTED');
    assert.equal(rejection.cause.code, 'INVALID_JSON');
    assert.equal(rejection.facts.code, 'INVALID_JSON');
    assert.equal(rejection.facts.output, model.returned.output);
    assert.equal(acceptance.invocation.failure.kind, 'exception');
  }
  assert.equal(generation[6].returned.error, error.cause);
  assert.equal(invocation.failure.error, error.cause);
  assert.notEqual(generation[3].invocation.context, generation[6].invocation.context);
});
