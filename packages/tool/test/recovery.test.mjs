import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { ToolModelCallLimitError } from '@weiliang0121/capix-tool';
import { assembly, member, host, journal, input, reply, call, final } from './fixture.mjs';

function config(onRun = () => {}, options = {}) {
  return {
    policyVersion: 'v1',
    checkpoint: true,
    tools: {
      lookup: member(
        'lookup',
        (value) => {
          onRun();
          return { text: value.key };
        },
        true,
      ),
    },
    ...options,
  };
}
function model(states) {
  return host((request) => (request.exchanges.length ? final : reply('first', [call('a', 'lookup', { key: 'fixed' })])), states);
}

test('cold restore uses exact saved entity/interaction basis without rerunning tools or sending', async () => {
  const originalHost = model();
  const saves = journal();
  let runs = 0;
  const original = assembly(
    config(() => runs++),
    originalHost,
    { store: saves.store },
  );
  assert.equal(await original.runner.run(input), 'finished');
  assert.equal(runs, 1);
  await originalHost.interactions.settled();
  originalHost.interactions.close();
  const snapshot = structuredClone(original.entity.snapshot());
  const nextHost = model(new Map(structuredClone([...originalHost.states])));
  const restored = assembly(
    config(() => assert.fail('cold resume reran tool')),
    nextHost,
    { entity: ModelExchanges.restore(snapshot), store: saves.replay() },
  );
  assert.equal(await restored.runner.resume(saves.contextId), 'finished');
  assert.deepEqual(nextHost.sent, []);
  assert.deepEqual(restored.entity.snapshot(), snapshot);
  nextHost.interactions.close();

  for (const variant of ['missing-origin', 'wrong-policy', 'missing-interaction', 'wrong-feedback', 'no-recovery-reader']) {
    const states = new Map(structuredClone([...originalHost.states]));
    if (variant === 'missing-interaction') states.clear();
    if (variant === 'wrong-feedback') for (const [id, state] of states) states.set(id, { ...state, feedback: { ...state.feedback, payload: final } });
    const candidateHost = model(states);
    const entity = variant === 'missing-origin' ? new ModelExchanges() : ModelExchanges.restore(snapshot);
    const candidate = assembly(
      config(() => assert.fail(`${variant} executed a tool`), variant === 'wrong-policy' ? { policyVersion: 'v2' } : {}),
      candidateHost,
      { entity, store: saves.replay(), recovery: variant !== 'no-recovery-reader' },
    );
    await assert.rejects(candidate.runner.resume(saves.contextId), undefined, variant);
    assert.deepEqual(candidateHost.sent, [], `${variant} must not resend to discover effects`);
    candidateHost.interactions.close();
  }
});

test('real save prefixes recover a prepared origin but reject missing child checkpoint and unknown feedback', async () => {
  const originalHost = model();
  let original;
  const prefixes = [];
  const saves = journal((commit, count) => {
    prefixes.push({ count, contract: commit.contract.key, point: commit.point, entity: structuredClone(original.entity.snapshot()), states: structuredClone([...originalHost.states]) });
  });
  original = assembly(config(), originalHost, { store: saves.store });
  assert.equal(await original.runner.run(input), 'finished');
  await originalHost.interactions.settled();
  originalHost.interactions.close();

  const prepared = prefixes.find((prefix) => prefix.contract === 'capix.tool' && prefix.point === 'prepared');
  assert.equal(prepared.entity.origins.length, 0, 'prepared checkpoint must precede begin');
  const preparedHost = model(new Map(prepared.states));
  const preparedFixture = assembly(config(), preparedHost, { entity: ModelExchanges.restore(prepared.entity), store: saves.replay(prepared.count) });
  assert.equal(await preparedFixture.runner.resume(saves.contextId), 'finished');
  assert.equal(preparedHost.sent.length, 2);
  assert.equal(preparedFixture.entity.snapshot().origins.length, 1);
  await preparedHost.interactions.settled();
  preparedHost.interactions.close();

  for (const point of ['model-waiting', 'established']) {
    const prefix = prefixes.find((prefix) => prefix.contract === (point === 'established' ? 'tool.completion' : 'capix.tool') && prefix.point === point);
    const candidateHost = model(new Map(prefix.states));
    const candidate = assembly(
      config(() => assert.fail('unsafe prefix ran a tool')),
      candidateHost,
      { entity: ModelExchanges.restore(prefix.entity), store: saves.replay(prefix.count) },
    );
    await assert.rejects(candidate.runner.resume(saves.contextId), undefined, point);
    assert.deepEqual(candidateHost.sent, [], `${point} must not probe by resending`);
    candidateHost.interactions.close();
  }
});

test('cold tools checkpoint preserves accepted feedback and continues only the remaining member', async () => {
  const makeConfig = (calls) => ({
    policyVersion: 'v1',
    checkpoint: true,
    tools: Object.fromEntries(
      ['lookup', 'compare'].map((name) => [
        name,
        member(
          name,
          (value) => {
            calls.push(name);
            return { text: value.key };
          },
          true,
        ),
      ]),
    ),
  });
  const send = (request) => (request.exchanges.length ? final : reply('pair', [call('a', 'lookup', { key: 'first' }), call('b', 'compare', { key: 'second' })]));
  const firstHost = host(send);
  let original;
  let saved;
  const saves = journal((commit, count) => {
    const snapshot = original.entity.snapshot();
    if (!saved && commit.contract.key === 'capix.tool' && commit.point === 'tools' && snapshot.entries[0]?.feedback.length === 1) saved = { count, snapshot: structuredClone(snapshot), states: structuredClone([...firstHost.states]) };
  });
  const before = [];
  original = assembly(makeConfig(before), firstHost, { store: saves.store });
  assert.equal(await original.runner.run(input), 'finished');
  await firstHost.interactions.settled();
  firstHost.interactions.close();
  assert.ok(saved);
  const after = [];
  const nextHost = host(send, new Map(saved.states));
  const next = assembly(makeConfig(after), nextHost, { entity: ModelExchanges.restore(saved.snapshot), store: saves.replay(saved.count) });
  assert.equal(await next.runner.resume(saves.contextId), 'finished');
  assert.deepEqual(before, ['lookup', 'compare']);
  assert.deepEqual(after, ['compare']);
  assert.equal(nextHost.sent.length, 1);
  assert.deepEqual(
    nextHost.sent[0].exchanges[0].feedback.map((item) => item.toolCallId),
    ['a', 'b'],
  );
  await nextHost.interactions.settled();
  nextHost.interactions.close();
});

test('cold recovery rejects malformed raw durable Interaction states without sending', async () => {
  const originalHost = model();
  const saves = journal();
  const original = assembly(config(), originalHost, { store: saves.store });
  assert.equal(await original.runner.run(input), 'finished');
  await originalHost.interactions.settled();
  originalHost.interactions.close();
  const snapshot = structuredClone(original.entity.snapshot());
  for (const variant of ['prepared-with-feedback', 'wrong-revision', 'missing-feedback-id']) {
    const states = new Map(structuredClone([...originalHost.states]));
    for (const [id, state] of states) {
      if (variant === 'prepared-with-feedback') states.set(id, { ...state, delivery: 'prepared', revision: 1 });
      if (variant === 'wrong-revision') states.set(id, { ...state, revision: state.revision + 1 });
      if (variant === 'missing-feedback-id') {
        const { id: omitted, ...feedback } = state.feedback;
        states.set(id, { ...state, feedback });
      }
    }
    const nextHost = model(states);
    const next = assembly(
      config(() => assert.fail(`${variant} ran a tool`)),
      nextHost,
      { entity: ModelExchanges.restore(snapshot), store: saves.replay() },
    );
    await assert.rejects(next.runner.resume(saves.contextId), undefined, variant);
    assert.deepEqual(nextHost.sent, [], `${variant} must not resend`);
    assert.deepEqual(next.entity.snapshot(), snapshot);
    nextHost.interactions.close();
  }
});

test('cold restore retains spent model calls and rejects a changed call limit without effects', async () => {
  const send = (request) => reply(`step-${request.exchanges.length}`, [call(`call-${request.exchanges.length}`, 'lookup', { key: String(request.exchanges.length) })]);
  const originalHost = host(send);
  let original;
  let saved;
  const saves = journal((commit, count) => {
    const snapshot = original.entity.snapshot();
    if (!saved && commit.contract.key === 'capix.tool' && commit.point === 'tools' && snapshot.entries.length === 2 && snapshot.entries[1].feedback.length === 1) saved = { count, snapshot: structuredClone(snapshot), states: structuredClone([...originalHost.states]) };
  });
  let originalRuns = 0;
  original = assembly(
    config(() => originalRuns++, { maxModelCalls: 3 }),
    originalHost,
    { store: saves.store },
  );
  try {
    await assert.rejects(original.runner.run(input), ToolModelCallLimitError);
    assert.equal(originalRuns, 3);
    assert.equal(originalHost.sent.length, 3);
    assert.ok(saved);
  } finally {
    await originalHost.interactions.settled();
    originalHost.interactions.close();
  }

  for (const maxModelCalls of [3, 4]) {
    let resumedRuns = 0;
    const nextHost = host(send, new Map(structuredClone(saved.states)));
    const next = assembly(
      config(() => resumedRuns++, { maxModelCalls }),
      nextHost,
      { entity: ModelExchanges.restore(saved.snapshot), store: saves.replay(saved.count) },
    );
    try {
      if (maxModelCalls === 3) {
        await assert.rejects(next.runner.resume(saves.contextId), (error) => {
          assert.ok(error instanceof ToolModelCallLimitError);
          assert.equal(error.calls, 3);
          assert.equal(error.limit, 3);
          return true;
        });
        assert.equal(nextHost.sent.length, 1, 'two saved model calls must still consume the limit');
        assert.equal(resumedRuns, 1, 'accepted tools must not run again');
        assert.deepEqual(
          next.entity.snapshot().entries.map((entry) => entry.feedback[0].content[0].text),
          ['0', '1', '2'],
        );
      } else {
        await assert.rejects(next.runner.resume(saves.contextId));
        assert.equal(nextHost.sent.length, 0);
        assert.equal(resumedRuns, 0);
        assert.deepEqual(next.entity.snapshot(), saved.snapshot);
      }
    } finally {
      await nextHost.interactions.settled();
      nextHost.interactions.close();
    }
  }
});
