import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { Tool } from '@weiliang0121/capix-tool';
import { assembly, member, host, journal, input, reply, call, final } from './fixture.mjs';

const inspection = new ChatCompletionsProvider({ endpoint: 'https://fixture.test/chat/completions', apiKey: 'fixture', model: 'fixture', fetch: () => assert.fail('offline test must not send') });
const image = { kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC' };

for (const checkpoint of [false, true])
  test(`seven small members and mixed image feedback use declared capacities (checkpoint=${checkpoint})`, async () => {
    let executions = 0;
    const create = {
      ...member(
        'create',
        () => {
          executions++;
          return { text: 'created' };
        },
        checkpoint,
      ),
      maxFeedbackBytes: 1024,
    };
    const preview = {
      ...member(
        'preview',
        () => {
          executions++;
          return { text: 'preview' };
        },
        checkpoint,
      ),
      maxFeedbackBytes: 256 * 1024,
    };
    preview.result.succeeded = () => ({ status: 'ok', content: [{ kind: 'text', text: 'preview' }, image] });
    const calls = [...Array.from({ length: 7 }, (_, index) => call(`create-${index}`, 'create', { key: String(index) })), call('preview', 'preview', { key: 'preview' })];
    const model = host((request) => (request.exchanges.length ? final : reply('batch', calls)));
    const fixture = assembly({ policyVersion: 'capacities.v1', checkpoint, tools: { create, preview }, budgets: { maxFeedbackBytes: 256 * 1024, maxWireRequestBytes: 2 * 1024 * 1024 } }, model, { inspection, ...(checkpoint ? { store: journal().store } : {}) });
    try {
      assert.equal(await fixture.runner.run(input), 'finished');
      assert.equal(executions, 8);
      assert.deepEqual(
        model.sent[1].exchanges[0].feedback.map((item) => item.toolCallId),
        calls.map((item) => item.id),
      );
      assert.equal(model.sent[1].exchanges[0].feedback.at(-1).content[1].kind, 'image');
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  });

for (const failed of [false, true])
  test(`mapped ${failed ? 'failed' : 'succeeded'} feedback enforces the member bound after its effect`, async () => {
    let executions = 0;
    let failureMappings = 0;
    const lookup = {
      ...member('lookup', () => {
        executions++;
        if (failed) throw new Error('business failure');
        return { text: 'x'.repeat(1024) };
      }),
      maxFeedbackBytes: 128,
    };
    lookup.result.failed = () => {
      failureMappings++;
      return { status: 'error', content: [{ kind: 'text', text: 'x'.repeat(1024) }] };
    };
    const model = host(() => reply('oversized', [call('a', 'lookup', { key: 'a' })]));
    const fixture = assembly({ policyVersion: 'capacities.v1', tools: { lookup } }, model);
    try {
      await assert.rejects(fixture.runner.run(input), (error) => error.code === 'TOOL_FEEDBACK_LIMIT' && error.phase === 'actual');
      assert.equal(executions, 1);
      assert.equal(failureMappings, failed ? 1 : 0);
      assert.equal(model.sent.length, 1);
      assert.equal(fixture.entity.snapshot().entries[0].feedback.length, 0);
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  });

for (const unknown of [false, true])
  test(`fixed ${unknown ? 'unknown' : 'invalid'} rejection cannot exceed capacity after an earlier tool effect`, async () => {
    let executions = 0;
    const lookup = {
      ...member('lookup', () => {
        executions++;
        return { text: 'ok' };
      }),
      maxFeedbackBytes: 128,
    };
    const model = host(() => reply('bad', [call('first', 'lookup', { key: 'a' }), call('bad', unknown ? 'missing' : 'lookup', '{')]));
    const fixture = assembly({ policyVersion: 'capacities.v1', tools: { lookup }, ...(unknown ? { budgets: { maxFeedbackBytes: 128 } } : {}) }, model);
    try {
      await assert.rejects(fixture.runner.run(input), (error) => error.code === 'TOOL_FEEDBACK_LIMIT' && error.phase === 'actual');
      assert.equal(executions, 0);
      assert.equal(model.sent.length, 1);
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  });

test('member capacity validates data without getters and is fixed in the recovery catalog', async () => {
  for (const value of [0, -1, 1.5, NaN, 4097]) assert.throws(() => new Tool({ policyVersion: 'v1', tools: { lookup: { ...member('lookup', () => ({ text: 'ok' })), maxFeedbackBytes: value } } }), /feedback byte limit/);
  const getter = member('lookup', () => ({ text: 'ok' }));
  Object.defineProperty(getter, 'maxFeedbackBytes', { enumerable: true, get: () => assert.fail('getter executed') });
  assert.throws(() => new Tool({ policyVersion: 'v1', tools: { lookup: getter } }), /data properties/);
  const configuration = (limit) => ({ policyVersion: 'v1', checkpoint: true, tools: { lookup: { ...member('lookup', () => ({ text: 'ok' }), true), maxFeedbackBytes: limit } } });
  const originalHost = host((request) => (request.exchanges.length ? final : reply('first', [call('a', 'lookup', { key: 'a' })])));
  const saves = journal();
  const original = assembly(configuration(512), originalHost, { store: saves.store });
  try {
    assert.equal(await original.runner.run(input), 'finished');
    await originalHost.interactions.settled();
    const snapshot = structuredClone(original.entity.snapshot());
    for (const limit of [512, 1024]) {
      const restoredHost = host(() => assert.fail('recovery resent'), new Map(structuredClone([...originalHost.states])));
      const restored = assembly(configuration(limit), restoredHost, { entity: ModelExchanges.restore(snapshot), store: saves.replay() });
      try {
        if (limit === 512) assert.equal(await restored.runner.resume(saves.contextId), 'finished');
        else await assert.rejects(restored.runner.resume(saves.contextId));
        assert.deepEqual(restoredHost.sent, []);
        assert.deepEqual(restored.entity.snapshot(), snapshot);
      } finally {
        restoredHost.interactions.close();
      }
    }
  } finally {
    originalHost.interactions.close();
  }
});

test('request reservation counts placeholder JSON once and reports reserved failures before effects', async () => {
  let reserved;
  for (const adjustment of [undefined, 0, -1]) {
    let executions = 0;
    const lookup = {
      ...member('lookup', () => {
        executions++;
        return { text: 'ok' };
      }),
      maxFeedbackBytes: 1024,
    };
    const model = host((request) => (request.exchanges.length ? final : reply('first', [call('a', 'lookup', { key: 'a' })])));
    const measurement = {
      inspectRequest(request) {
        const requestBytes = Buffer.byteLength(JSON.stringify(request));
        const feedback = request.exchanges?.[0]?.feedback[0];
        if (feedback?.content.length > 1) reserved = requestBytes + 1024 - Buffer.byteLength(JSON.stringify(feedback));
        return { requestBytes, wireBytes: requestBytes };
      },
    };
    const fixture = assembly({ policyVersion: 'capacities.v1', tools: { lookup }, ...(adjustment === undefined ? {} : { budgets: { maxRequestBytes: reserved + adjustment } }) }, model, { inspection: measurement });
    try {
      if (adjustment === -1) {
        await assert.rejects(fixture.runner.run(input), (error) => error.code === 'TOOL_REQUEST_LIMIT' && error.phase === 'reserved');
        assert.equal(executions, 0);
      } else {
        assert.equal(await fixture.runner.run(input), 'finished');
        assert.equal(executions, 1);
      }
    } finally {
      await model.interactions.settled();
      model.interactions.close();
    }
  }
});

test('a call identity that cannot fit its member feedback is rejected before effects', async () => {
  let executions = 0;
  const lookup = {
    ...member('lookup', () => {
      executions++;
      return { text: 'ok' };
    }),
    maxFeedbackBytes: 128,
  };
  const model = host(() => reply('first', [call('x'.repeat(200), 'lookup', { key: 'a' })]));
  const fixture = assembly({ policyVersion: 'capacities.v1', tools: { lookup } }, model);
  try {
    await assert.rejects(fixture.runner.run(input), (error) => error.code === 'TOOL_FEEDBACK_LIMIT' && error.phase === 'reserved');
    assert.equal(executions, 0);
  } finally {
    await model.interactions.settled();
    model.interactions.close();
  }
});

test('a feedback budget failure remains terminal on a new Runner', async () => {
  let executions = 0;
  const configuration = () => ({
    policyVersion: 'capacities.v1',
    checkpoint: true,
    tools: {
      lookup: {
        ...member(
          'lookup',
          () => {
            executions++;
            return { text: 'x'.repeat(1024) };
          },
          true,
        ),
        maxFeedbackBytes: 128,
      },
    },
  });
  const saves = journal();
  const model = host(() => reply('oversized', [call('a', 'lookup', { key: 'a' })]));
  const original = assembly(configuration(), model, { store: saves.store });
  try {
    await assert.rejects(original.runner.run(input), /TOOL_FEEDBACK_LIMIT/);
    assert.equal(executions, 1);
    await model.interactions.settled();
    const snapshot = structuredClone(original.entity.snapshot());
    const restoredHost = host(() => assert.fail('terminal failure resent'), new Map(structuredClone([...model.states])));
    const restored = assembly(configuration(), restoredHost, { entity: ModelExchanges.restore(snapshot), store: saves.store });
    try {
      await assert.rejects(restored.runner.resume(saves.contextId));
      assert.equal(executions, 1);
      assert.deepEqual(restoredHost.sent, []);
      assert.deepEqual(restored.entity.snapshot(), snapshot);
    } finally {
      restoredHost.interactions.close();
    }
  } finally {
    model.interactions.close();
  }
});
