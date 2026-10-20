import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeObserver } from '@capix/observer-service';
import { DeclaredException } from '@capix/server-runtime';

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
    await environment.driver.run(
      environment.scene,
      { messages: [{ role: 'user', content: '你好' }] },
      {
        settings,
        executionCallbacks: {
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
  assert.deepEqual(calls, ['answer', 'memory']);
  const children = invocation.children.values();
  assert.deepEqual(
    children.map((child) => child.key),
    ['preparation', 'decision', 'generation', 'decision', 'extraction'],
  );
  assert.deepEqual(
    children.map((child) => child.reception.status),
    ['accepted', 'accepted', 'accepted', 'accepted', 'accepted'],
  );
  const generation = children.find((child) => child.key === 'generation');
  const decisions = children.filter((child) => child.key === 'decision');
  assert.deepEqual(
    decisions.map((child) => child.returned.output.kind),
    ['invoke', 'finish'],
  );
  assert.ok(
    decisions.every((child) => child.invocation.children.values().length === 0),
    'deterministic decisions do not add model calls',
  );
  assert.deepEqual(
    generation.invocation.children.values().map((child) => child.key),
    ['context', 'request', 'model', 'acceptance'],
  );
  assert.deepEqual(generation.returned.output, answer);
  assert.deepEqual(generation.reception.output.response.message, environment.transcript.get(1));
  assert.equal(generation.reception.output.receipt.start, 1, 'fixed append identifies the canonical message without retaining its live reference');
  assert.deepEqual(invocation.context.state.output, answer);
});

test('memory failure preserves the delivered answer and completed generation relationship', async () => {
  const { invocation, environment, error, calls } = await execute('memory');
  assert.equal(error.code, 'UNHANDLED_EXCEPTION');
  assert.ok(error.cause instanceof DeclaredException);
  assert.equal(error.cause.code, 'MODEL_OUTPUT_REJECTED');
  assert.equal(error.cause.cause.code, 'INVALID_JSON');
  assert.equal(error.cause.facts.code, 'INVALID_JSON');
  assert.deepEqual(calls, ['answer', 'memory']);
  assert.equal(environment.transcript.length, 2);
  assert.equal(environment.transcript.get(1).content, answer.content);
  const children = invocation.children.values();
  const generated = children.find((child) => child.key === 'generation');
  const extracted = children.find((child) => child.key === 'extraction');
  assert.equal(generated.invocation.context.status, 'succeeded');
  assert.equal(generated.reception.status, 'accepted');
  assert.equal(extracted.returned.status, 'failed');
  assert.equal(extracted.returned.error, error.cause);
  assert.equal(extracted.invocation.failure.kind, 'exception');
  const extraction = extracted.invocation.children.values();
  const model = extraction.find((child) => child.key === 'model');
  const acceptance = extraction.find((child) => child.key === 'acceptance');
  assert.equal(error.cause.facts.output, model.returned.output);
  assert.equal(error.cause.facts.output.content, 'invalid JSON');
  assert.equal(acceptance.returned.error, error.cause);
  assert.deepEqual(
    extraction.map((child) => child.key),
    ['request', 'model', 'acceptance'],
  );
});

test('invalid model output stays available through the actual child invocation without querying records', async () => {
  const { invocation, error, calls, environment } = await execute('answer');
  assert.equal(error.code, 'UNHANDLED_EXCEPTION');
  assert.ok(error.cause instanceof DeclaredException);
  assert.deepEqual(calls, ['answer', 'answer']);
  assert.equal(environment.transcript.length, 1);
  const children = invocation.children.values();
  assert.deepEqual(
    children.map((child) => child.key),
    ['preparation', 'decision', 'generation'],
  );
  const generation = children.find((child) => child.key === 'generation').invocation.children.values();
  const models = generation.filter((child) => child.key === 'model');
  const acceptances = generation.filter((child) => child.key === 'acceptance');
  assert.equal(models.length, 2);
  assert.equal(acceptances.length, 2);
  assert.equal(models[0].returned.output.content, 'invalid JSON');
  assert.equal(models[0].reception.status, 'accepted');
  for (const [index, model] of models.entries()) {
    const acceptance = acceptances[index];
    const rejection = acceptance.returned.error;
    assert.ok(rejection instanceof DeclaredException);
    assert.equal(rejection.code, 'MODEL_OUTPUT_REJECTED');
    assert.equal(rejection.cause.code, 'INVALID_JSON');
    assert.equal(rejection.facts.code, 'INVALID_JSON');
    assert.equal(rejection.facts.output, model.returned.output);
    assert.equal(acceptance.invocation.failure.kind, 'exception');
  }
  assert.equal(acceptances[1].returned.error, error.cause);
  assert.equal(invocation.failure.error, error.cause);
  assert.notEqual(acceptances[0].invocation.context, acceptances[1].invocation.context);
});
