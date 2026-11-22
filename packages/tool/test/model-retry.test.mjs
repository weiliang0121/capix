import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { Interactions } from '@weiliang0121/capix-interaction';
import { assembly, contract, host, input, journal, member } from './fixture.mjs';

const event = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (id, delta, finishReason = null) => ({ id, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] });
const toolDelta = (id, key) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ key }) } }] });
const toolWire = (id, callId, key) => event(chunk(id, toolDelta(callId, key), 'tool_calls')) + event('[DONE]');
const finalWire = event(chunk('final', { content: 'finished' }, 'stop')) + event('[DONE]');
const response = (body) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const provider = (fetcher) => new ChatCompletionsProvider({ endpoint: 'https://fixture.invalid/chat/completions', apiKey: 'offline', model: 'fixture', retry: { maxAttempts: 3, delayMs: 0, maxDelayMs: 0 }, fetch: fetcher });
const streamedInput = { request: { ...input.request, stream: true } };

for (const checkpoint of [false, true])
  test(`Tool executes only the winning retry's tool call after a cut-off stream (checkpoint=${checkpoint})`, async () => {
    const effects = [];
    const bodies = [];
    const attempts = [];
    const modelProvider = provider(async (_url, options) => {
      bodies.push(options.body);
      if (bodies.length === 1) {
        // A complete-looking tool selection remains a preview until the entire reply validates.
        assert.deepEqual(effects, []);
        return response(event(chunk('discarded', toolDelta('discarded-call', 'must-not-execute'))));
      }
      if (bodies.length === 2) {
        assert.deepEqual(effects, []);
        return response(toolWire('winner', 'winner-call', 'accepted'));
      }
      assert.deepEqual(effects, ['accepted']);
      return response(finalWire);
    });
    const model = host((request) => modelProvider.complete(request, { attempt: (value) => attempts.push(value) }));
    const fixture = assembly(
      {
        policyVersion: 'retry.v1',
        checkpoint,
        tools: {
          lookup: member(
            'lookup',
            ({ key }) => {
              effects.push(key);
              return { text: key };
            },
            checkpoint,
          ),
        },
      },
      model,
      { store: journal().store, inspection: modelProvider },
    );
    try {
      assert.equal(await fixture.runner.run(streamedInput), 'finished');
      assert.equal(bodies.length, 3);
      assert.equal(model.sent.length, 2);
      assert.equal(bodies[0], bodies[1]);
      assert.deepEqual(effects, ['accepted']);
      assert.equal(model.sent[1].exchanges[0].reply.id, 'winner');
      assert.deepEqual(
        model.sent[1].exchanges[0].feedback.map((value) => value.toolCallId),
        ['winner-call'],
      );
      assert.deepEqual(
        fixture.entity.snapshot().entries.map((entry) => entry.reply.id),
        ['winner', 'final'],
      );
      assert.deepEqual(
        attempts.map((value) => [value.kind, value.attempt]),
        [
          ['started', 1],
          ['failed', 1],
          ['retrying', 1],
          ['started', 2],
          ['completed', 2],
          ['started', 1],
          ['completed', 1],
        ],
      );
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  });

for (const checkpoint of [false, true])
  test(`a retry on the next model request preserves previously executed tool effects (checkpoint=${checkpoint})`, async () => {
    const effects = [];
    const bodies = [];
    const modelProvider = provider(async (_url, options) => {
      bodies.push(options.body);
      if (bodies.length === 1) return response(toolWire('first', 'first-call', 'first-effect'));
      assert.deepEqual(effects, bodies.length < 4 ? ['first-effect'] : ['first-effect', 'second-effect']);
      const request = JSON.parse(options.body);
      assert.equal(request.messages.find((value) => value.role === 'tool').tool_call_id, 'first-call');
      if (bodies.length === 2) return response(event(chunk('discarded-second', toolDelta('discarded-call', 'must-not-execute'))));
      if (bodies.length === 3) return response(toolWire('second', 'second-call', 'second-effect'));
      return response(finalWire);
    });
    const model = host((request) => modelProvider.complete(request));
    const fixture = assembly(
      {
        policyVersion: 'retry.v1',
        checkpoint,
        tools: {
          lookup: member(
            'lookup',
            ({ key }) => {
              effects.push(key);
              return { text: key };
            },
            checkpoint,
          ),
        },
      },
      model,
      { store: journal().store, inspection: modelProvider },
    );
    try {
      assert.equal(await fixture.runner.run(streamedInput), 'finished');
      assert.deepEqual(effects, ['first-effect', 'second-effect']);
      assert.equal(bodies.length, 4);
      assert.equal(bodies[1], bodies[2]);
      assert.equal(model.sent.length, 3);
      assert.deepEqual(
        model.sent[2].exchanges.map((exchange) => exchange.feedback[0].toolCallId),
        ['first-call', 'second-call'],
      );
      assert.deepEqual(
        fixture.entity.snapshot().entries.map((entry) => entry.reply.id),
        ['first', 'second', 'final'],
      );
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  });

test('a fully received model reply rejected by Tool intake does not resend or execute tools', async () => {
  let sends = 0;
  let executions = 0;
  const modelProvider = provider(async () => {
    sends++;
    return response(toolWire('full-reply', 'call', 'unused'));
  });
  const model = host((request) => modelProvider.complete(request));
  const fixture = assembly(
    {
      policyVersion: 'retry.v1',
      budgets: { maxReplyBytes: 32 },
      tools: {
        lookup: member('lookup', () => {
          executions++;
          return { text: 'unused' };
        }),
      },
    },
    model,
    { inspection: modelProvider },
  );
  try {
    await assert.rejects(fixture.runner.run(streamedInput), /limit|budget|exceed/i);
    await model.interactions.settled();
    assert.equal(sends, 1);
    assert.equal(model.sent.length, 1);
    assert.equal(executions, 0);
    assert.equal([...model.states.values()][0].feedback.payload.id, 'full-reply');
  } finally {
    await model.interactions.settled();
    model.interactions.close();
  }
});

test('failure persisting a fully received Interaction reply does not resend the model request', async () => {
  const failure = new Error('offline feedback store failure');
  const states = new Map();
  let sends = 0;
  let replyCommits = 0;
  let executions = 0;
  const modelProvider = provider(async () => {
    sends++;
    return response(toolWire('full-reply', 'call', 'unused'));
  });
  const interactions = new Interactions().register(contract, {
    send: (request) => modelProvider.complete(request),
    persistence: {
      create(state) {
        states.set(state.id, structuredClone(state));
      },
      commit({ expectedRevision, state }) {
        assert.equal(states.get(state.id).revision, expectedRevision);
        if (state.feedback) {
          replyCommits++;
          throw failure;
        }
        states.set(state.id, structuredClone(state));
      },
      read: (id) => states.get(id),
    },
  });
  const fixture = assembly(
    {
      policyVersion: 'retry.v1',
      tools: {
        lookup: member('lookup', () => {
          executions++;
          return { text: 'unused' };
        }),
      },
    },
    { interactions, states },
    { inspection: modelProvider },
  );
  try {
    await assert.rejects(fixture.runner.run(streamedInput));
    await interactions.settled();
    assert.equal(replyCommits, 1);
    assert.equal(sends, 1);
    assert.equal(executions, 0);
    assert.equal(interactions.pendingCount, 0);
    assert.equal([...states.values()][0].feedback, undefined);
    assert.deepEqual(fixture.entity.snapshot().entries, []);
  } finally {
    await interactions.settled();
    interactions.close();
  }
});

test('a completed-attempt consumer failure cannot resend or turn a validated tool choice into an effect', async () => {
  const failure = new Error('completed consumer failed');
  let sends = 0;
  let executions = 0;
  let completions = 0;
  const modelProvider = provider(async () => {
    sends++;
    return response(toolWire('full-reply', 'call', 'unused'));
  });
  const model = host((request) =>
    modelProvider.complete(request, {
      attempt(value) {
        if (value.kind === 'completed') {
          completions++;
          throw failure;
        }
      },
    }),
  );
  const fixture = assembly(
    {
      policyVersion: 'retry.v1',
      tools: {
        lookup: member('lookup', () => {
          executions++;
          return { text: 'unused' };
        }),
      },
    },
    model,
    { inspection: modelProvider },
  );
  try {
    await assert.rejects(fixture.runner.run(streamedInput));
    await model.interactions.settled();
    assert.equal(completions, 1);
    assert.equal(sends, 1);
    assert.equal(model.sent.length, 1);
    assert.equal(executions, 0);
    assert.deepEqual(fixture.entity.snapshot().entries, []);
  } finally {
    await model.interactions.settled();
    model.interactions.close();
  }
});
