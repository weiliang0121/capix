import { createConversationRunner } from '../fixtures/conversation-runner.mjs';
import { ActiveContent } from '@capix/observer-service';
import { ModelInteractions, ModelSource, modelRegenerationInput, modelOutputRejected } from '@capix/observer-service';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationStructure } from '@capix/observer-service';
import { RuntimeError, CallableRecord, InvocationRecord, Recorder, RecordBook, bindRecording, Transcript, Memories, SelectionUsage } from '@capix/server-runtime';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const answer = { kind: 'answer', content: '修正后的回答' };
const output = (content, finishReason = 'stop') => ({ id: 'fixture', model: 'fixture', content, finishReason, usage: null });

function fixture(answers, { recorded = true, signal, configuration = settings, onCall, recordingFailure = 'isolate', configureDefinition } = {}) {
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
  const recorder = recorded ? new Recorder(new RecordBook()) : undefined;
  const recording = recorder ? bindRecording(recorder, { failure: recordingFailure }) : undefined;
  const transcript = new Transcript([], { observation: recording?.transcript });
  const memories = new Memories(transcript, { observation: recording?.memory });
  const entities = { transcript, memories, active: new ActiveContent(transcript, memories), selectionUsage: new SelectionUsage() };
  const definition = createConversationStructure();
  configureDefinition?.(definition);

  const runner = createConversationRunner(definition, entities, new ModelInteractions(new ModelSource(provider)), { observations: recording ? [recording] : undefined });
  const environment = { ...entities, definition, recording, book: recorder?.book, runner, scene: runner.scene };
  let invocation;
  return {
    ...environment,
    calls,
    get invocation() {
      return invocation;
    },
    run: () =>
      environment.runner.run(
        { messages },
        {
          settings: configuration,
          signal,
          executionCallbacks: {
            started: (_context, current) => {
              invocation = current;
            },
          },
        },
      ),
    recordFor: (call) => [...(environment.book?.values() ?? [])].find((record) => record.contextId === call.context.id),
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
      ['answer', 'answer', 'memory'],
    );
    assert.equal(f.transcript.length, 2);
    assert.equal(f.transcript.get(1).content, answer.content);
    const original = f.calls[0].request;
    const repeated = f.calls[1].request;
    assert.deepEqual(repeated.messages.slice(0, -2), original.messages);
    assert.deepEqual(repeated.messages.at(-2), { role: 'assistant', content: raw });
    assert.ok(repeated.messages.at(-1).content.includes(code));
    assert.equal(original.messages.length + 2, repeated.messages.length);
    const generation = f.generation();
    assert.equal(generation.context.progress.round, 1);
    assert.deepEqual(
      generation.children.values().map((relation) => [relation.key, relation.round]),
      [
        ['context', 1],
        ['request', 1],
        ['candidate', 1],
        ['regeneration', 1],
        ['candidate', 1],
      ],
    );
    const rejected = generation.children.values()[2];
    assert.equal(rejected.returned.error.code, 'MODEL_OUTPUT_REJECTED');
    assert.equal(rejected.returned.error.facts.code, code);
    assert.equal(rejected.returned.error.cause.code, code);
    assert.equal(rejected.invocation.view.failure.kind, 'exception');
    assert.equal(rejected.invocation.context.status, 'failed');
    assert.equal(f.recordFor(generation).value.processes.filter((process) => process.type === 'continue').length, 0);
    assert.equal(rejected.reception.status, 'handled');
    assert.notEqual(rejected.invocation.context.id, generation.children.values()[4].invocation.context.id);
    const previous = rejected.invocation.children.values()[0];
    assert.equal(previous.returned.output.content, raw);
    assert.equal(f.recordFor(previous.invocation).value.input.messages.length, original.messages.length);
  });
}

test('second invalid response stops with its original error and leaves both failed acceptances', async () => {
  const f = fixture([output('bad first'), output('bad second')]);
  await assert.rejects(f.run(), (error) => error.code === 'MODEL_OUTPUT_REJECTED' && error.facts.code === 'INVALID_JSON');
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['answer', 'answer'],
  );
  assert.equal(f.transcript.length, 1);
  const generation = f.generation();
  const children = generation.children.values();
  assert.equal(children[2].invocation.context.status, 'failed');
  assert.equal(children[4].invocation.context.status, 'failed');
  assert.equal(generation.context.state.error, children[4].returned.error);
  assert.equal(generation.context.state.error.facts.code, 'INVALID_JSON');
});

for (const failure of [new RuntimeError('NETWORK_ERROR', 'network'), new RuntimeError('CALL_ABORTED', 'timeout'), new RuntimeError('HTTP_503', 'unavailable'), new RuntimeError('PROVIDER_ENVELOPE', 'bad HTTP envelope'), output('partial', 'length'), output('filtered', 'content_filter')]) {
  test(`does not regenerate ${failure.code ?? failure.finishReason}`, async () => {
    const f = fixture([failure]);
    await assert.rejects(f.run());
    assert.deepEqual(
      f.calls.map((call) => call.purpose),
      ['answer'],
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
    ['answer'],
  );
});

test('feedback capacity overflow stops before a second external call without truncation', async () => {
  const f = fixture([output('x'.repeat(15000))], { configuration: { ...settings, contextBudget: 12000 } });
  await assert.rejects(f.run(), (error) => error.code === 'CAPACITY_EXCEEDED');
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['answer'],
  );
  const children = f.generation().children.values();
  assert.equal(children.at(-1).key, 'regeneration');
  assert.equal(children.at(-1).round, 1);
  assert.equal(children[2].invocation.children.values()[0].returned.output.content.length, 15000);
});

test('regeneration works without records and keeps per-call evidence isolated', async () => {
  const f = fixture([output('bad'), output(JSON.stringify(answer)), output(JSON.stringify(answer))], { recorded: false });
  assert.deepEqual(await f.run(), answer);
  const first = f.generation();
  assert.equal(f.recordFor(first), undefined);
  f.transcript.append({ role: 'user', content: '继续' });
  assert.deepEqual(await f.run(), answer);
  assert.equal(f.generation().context.progress.round, 1);
  assert.notEqual(first, f.generation());
  assert.equal(first.children.values().length, 5);
});

test('record failure cannot be classified as an output rejection or trigger a second request', async (t) => {
  const append = InvocationRecord.prototype.append;
  t.mock.method(InvocationRecord.prototype, 'append', function (process) {
    if (this instanceof CallableRecord && this.name === 'acceptModelOutput' && process.type === 'throw') throw new Error('record failed');
    return append.call(this, process);
  });
  const f = fixture([output('bad')], { recordingFailure: 'propagate' });
  await assert.rejects(f.run(), (error) => error instanceof AggregateError);
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['answer'],
  );
  assert.equal(f.generation().context.progress.round, 1);
});

test('regeneration policy admits only complete model-output validation failures', () => {
  const request = { model: 'fixture', messages: [], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 256, stream: true };
  const response = output('bad');
  const allowed = modelOutputRejected.create('invalid', { code: 'INVALID_JSON', output: response });
  assert.deepEqual(modelRegenerationInput(request, allowed), { request, output: response, error: { code: 'INVALID_JSON', message: 'invalid' } });
  assert.equal(modelRegenerationInput(request, new RuntimeError('INVALID_JSON', 'unrelated')), undefined);
  assert.equal(modelRegenerationInput(request, modelOutputRejected.create('partial', { code: 'INVALID_JSON', output: output('partial', 'length') })), undefined);
  assert.equal(modelRegenerationInput(request, modelOutputRejected.create('other', { code: 'NETWORK_ERROR', output: response })), undefined);
});

test('a business run can consume a single candidate without enabling regeneration', async () => {
  const f = fixture([output('bad')], {
    configureDefinition({ generation }) {
      generation.run = async (work) => {
        const context = await work.children.invoke(generation.assembleContext, work.input.context);
        const request = await work.children.invoke(generation.prepareRequest, { ...context, memories: work.input.memories });
        return work.children.invoke(generation.candidate, request);
      };
    },
  });
  await assert.rejects(f.run(), (error) => error.code === 'MODEL_OUTPUT_REJECTED' && error.facts.code === 'INVALID_JSON');
  assert.deepEqual(
    f.calls.map((call) => call.purpose),
    ['answer'],
  );
});
