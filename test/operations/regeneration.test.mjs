import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObserverBinding, ObserverRuntimeDefinition, initializeObserver } from '@capix-observer/service';
import { RuntimeError, createRuntime, AttemptRecord, InvocationRecord } from '@capix-observer/runtime';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const answer = { kind: 'answer', content: '修正后的回答' };
const output = (content, finishReason = 'stop') => ({ id: 'fixture', model: 'fixture', content, finishReason, usage: null });

function fixture(answers, { recorded = true, signal, configuration = settings, onCall } = {}) {
  const calls = [];
  const provider = {
    async invoke(request, purpose, callSignal) {
      calls.push({ request, purpose, signal: callSignal });
      onCall?.(purpose);
      if (purpose === 'selection') return output('{"historyIndexes":[]}');
      if (purpose === 'memory') return output('{"memories":[]}');
      const result = answers.shift();
      if (result instanceof Error) throw result;
      assert.ok(result, 'unexpected model call');
      return result;
    },
  };
  const messages = [{ role: 'user', content: '你好' }];
  const environment = recorded
    ? initializeObserver(provider, messages)
    : (() => {
        const runtime = createRuntime({ messages });
        return { runtime, transcript: runtime.context.transcript, execution: new ObserverBinding(runtime, new ObserverRuntimeDefinition(provider)) };
      })();
  let invocation;
  return {
    ...environment,
    calls,
    get invocation() {
      return invocation;
    },
    run: () =>
      environment.execution.call(environment.transcript.current('user'), { settings: configuration, transcript: environment.transcript, signal }, (_context, current) => {
        invocation = current;
      }),
    generation: () => invocation.children.values().find((child) => child.key === 'generation').invocation,
  };
}

for (const [raw, code] of [
  ['not JSON', 'INVALID_JSON'],
  ['{"kind":"tool","content":"x"}', 'OUTPUT_SHAPE'],
  ['', 'EMPTY_OUTPUT'],
]) {
  test(`completed ${code} output permits one feedback generation with separate child facts`, async () => {
    const f = fixture([output(raw), output(JSON.stringify(answer))]);
    assert.deepEqual(await f.run(), answer);
    assert.deepEqual(
      f.calls.map((call) => call.purpose),
      ['selection', 'answer', 'answer', 'memory'],
    );
    assert.equal(f.transcript.length, 2);
    assert.equal(f.transcript.get(1).content, answer.content);
    const original = f.calls[1].request;
    const repeated = f.calls[2].request;
    assert.deepEqual(repeated.messages.slice(0, -2), original.messages);
    assert.deepEqual(repeated.messages.at(-2), { role: 'assistant', content: raw });
    assert.ok(repeated.messages.at(-1).content.includes(code));
    assert.equal(original.messages.length + 2, repeated.messages.length);
    const generation = f.generation();
    assert.equal(generation.context.progress.round, 2);
    assert.deepEqual(
      generation.children.values().map((relation) => [relation.key, relation.round]),
      [
        ['context', 1],
        ['request', 1],
        ['model', 1],
        ['acceptance', 1],
        ['request', 2],
        ['model', 2],
        ['acceptance', 2],
      ],
    );
    const rejected = generation.children.values()[3];
    assert.equal(rejected.returned.error.code, code);
    assert.equal(rejected.invocation.context.status, 'failed');
    assert.equal(generation.record.value.processes.filter((process) => process.type === 'continue').length, 1);
    assert.ok(generation.record.value.processes.some((process) => process.round === 2));
    const previous = generation.children.values()[2];
    assert.equal(previous.returned.output.content, raw);
    assert.equal(previous.invocation.record.value.input.messages.length, original.messages.length);
  });
}

test('second invalid response stops with its original error and leaves both failed acceptances', async () => {
  const f = fixture([output('bad first'), output('bad second')]);
  await assert.rejects(f.run(), (error) => error.code === 'INVALID_JSON');
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['selection', 'answer', 'answer'],
  );
  assert.equal(f.transcript.length, 1);
  const generation = f.generation();
  const children = generation.children.values();
  assert.equal(children[3].invocation.context.status, 'failed');
  assert.equal(children[6].invocation.context.status, 'failed');
  assert.equal(generation.context.state.error, children[6].returned.error);
  assert.equal(generation.context.state.error.code, 'INVALID_JSON');
});

for (const failure of [new RuntimeError('NETWORK_ERROR', 'network'), new RuntimeError('CALL_ABORTED', 'timeout'), new RuntimeError('HTTP_503', 'unavailable'), new RuntimeError('PROVIDER_ENVELOPE', 'bad HTTP envelope'), output('partial', 'length'), output('filtered', 'content_filter')]) {
  test(`does not regenerate ${failure.code ?? failure.finishReason}`, async () => {
    const f = fixture([failure]);
    await assert.rejects(f.run());
    assert.deepEqual(
      f.calls.map((call) => call.purpose),
      ['selection', 'answer'],
    );
    assert.equal(f.generation().context.progress.round, 1);
  });
}

test('cancellation after receiving a malformed result prevents regeneration', async () => {
  const controller = new AbortController();
  const f = fixture([output('bad')], {
    signal: controller.signal,
    onCall(purpose) {
      if (purpose === 'answer') controller.abort();
    },
  });
  await assert.rejects(f.run(), (error) => error.code === 'INVOCATION_CANCELLED');
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['selection', 'answer'],
  );
});

test('feedback capacity overflow stops before a second external call without truncation', async () => {
  const f = fixture([output('x'.repeat(15000))], { configuration: { ...settings, contextBudget: 12000 } });
  await assert.rejects(f.run(), (error) => error.code === 'CAPACITY_EXCEEDED');
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['selection', 'answer'],
  );
  const children = f.generation().children.values();
  assert.equal(children.at(-1).key, 'request');
  assert.equal(children.at(-1).round, 2);
  assert.equal(children[2].returned.output.content.length, 15000);
});

test('regeneration works without records and keeps per-call evidence isolated', async () => {
  const f = fixture([output('bad'), output(JSON.stringify(answer)), output(JSON.stringify(answer))], { recorded: false });
  assert.deepEqual(await f.run(), answer);
  const first = f.generation();
  assert.equal(first.record, undefined);
  f.transcript.append({ role: 'user', content: '继续' });
  assert.deepEqual(await f.run(), answer);
  assert.equal(f.generation().context.progress.round, 1);
  assert.notEqual(first, f.generation());
  assert.equal(first.children.values().length, 7);
});

test('record failure cannot be classified as an output rejection or trigger a second request', async (t) => {
  const append = InvocationRecord.prototype.append;
  t.mock.method(InvocationRecord.prototype, 'append', function (process) {
    if (this instanceof AttemptRecord && this.name === 'acceptModelOutput' && process.type === 'throw') throw new Error('record failed');
    return append.call(this, process);
  });
  const f = fixture([output('bad')]);
  await assert.rejects(f.run(), (error) => error instanceof AggregateError);
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['selection', 'answer'],
  );
  assert.equal(f.generation().context.progress.round, 1);
});

test('regeneration entry enforces evidence, feedback and budget independently of parent choice', async (t) => {
  const f = fixture([output('bad'), output(JSON.stringify(answer))]);
  const behavior = f.execution.definition.executions.conversation.operations.generation;
  const receive = behavior.receive;
  const capability = behavior.invokeModel.regeneration;
  assert.equal(capability.declaration.maxAdditionalCalls, 1);
  assert.deepEqual(capability.declaration.rejectionCodes, ['INVALID_JSON', 'EMPTY_OUTPUT', 'OUTPUT_SHAPE']);
  let checkedRounds = 0;
  t.mock.method(behavior, 'receive', function (context, result, invocation, bindings) {
    const children = invocation.children.values();
    const evidence = { previous: children[2], rejection: children[3] };
    const count = children.length;
    if (context.progress.round === 1) {
      assert.equal(capability.allows(invocation, evidence), true);
      const invalid = { previous: children[1], rejection: children[3] };
      assert.equal(capability.allows(invocation, invalid), false);
      assert.throws(() => bindings.entry(capability.entry).create(invocation, { request: f.calls[1].request, evidence: invalid }, { key: 'model' }), { code: 'MODEL_REGENERATION_NOT_ALLOWED' });
      // The original request omits required error feedback, even with valid evidence.
      assert.throws(() => bindings.entry(capability.entry).create(invocation, { request: f.calls[1].request, evidence }, { key: 'model' }), { code: 'MODEL_REGENERATION_NOT_ALLOWED' });
    } else {
      assert.equal(capability.allows(invocation, evidence), false);
      assert.throws(() => bindings.entry(capability.entry).create(invocation, { request: f.calls[2].request, evidence }, { key: 'model' }), { code: 'MODEL_REGENERATION_NOT_ALLOWED' });
    }
    assert.equal(invocation.children.values().length, count);
    checkedRounds += 1;
    return receive.call(this, context, result, invocation, bindings);
  });
  assert.deepEqual(await f.run(), answer);
  assert.equal(checkedRounds, 2);
});

test('parent may decline an eligible regeneration without changing child capability', async (t) => {
  const f = fixture([output('bad')]);
  t.mock.method(f.execution.definition.executions.conversation.operations.generation, 'receive', function (_context, result, invocation) {
    const children = invocation.children.values();
    assert.equal(this.invokeModel.regeneration.allows(invocation, { previous: children[2], rejection: children[3] }), true);
    throw result.error;
  });
  await assert.rejects(f.run(), { code: 'INVALID_JSON' });
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['selection', 'answer'],
  );
});
