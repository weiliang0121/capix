import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { input, journal } from './fixture.mjs';
import { MiB, durable, capacityHost, capacityAssembly, closeCapacityHost } from './capacity-large-request-support.mjs';

test('provider inspection limits stop an oversized wire reservation before the tool effect', async () => {
  const host = capacityHost({ requestLimit: 2 * MiB });
  const effects = [];
  const fixture = capacityAssembly(host, { effects });
  try {
    await assert.rejects(fixture.runner.run(input), (error) => error.code === 'TOOL_WIRE_REQUEST_LIMIT' && error.phase === 'reserved' && error.limit === 2 * MiB);
    assert.deepEqual(effects, []);
    assert.deepEqual(
      host.wire.map(({ turn }) => turn),
      [0],
    );
    assert.equal(fixture.entity.snapshot().entries[0].feedback.length, 0);
  } finally {
    await closeCapacityHost(host);
  }
});

for (const checkpoint of [false, true])
  test(`accumulated history above 2 MiB traverses Tool, exchanges, Interaction and real provider (checkpoint=${checkpoint})`, async () => {
    const host = capacityHost();
    const effects = [];
    const saves = journal();
    const fixture = capacityAssembly(host, { checkpoint, store: checkpoint ? saves.store : undefined, effects });
    try {
      assert.equal(await fixture.runner.run(input), 'finished');
      assert.deepEqual(effects, ['0', '1', '2']);
      assert.deepEqual(
        host.sent.map(({ turn }) => turn),
        [0, 1, 2, 3],
      );
      assert.deepEqual(
        host.wire.map(({ turn }) => turn),
        [0, 1, 2, 3],
      );
      assert.ok(host.sent.at(-1).bytes > 2 * MiB);
      assert.ok(host.wire.at(-1).bytes > 2 * MiB);
      const snapshot = durable(fixture.entity.snapshot());
      assert.ok(snapshot.entries.every((entry) => Buffer.byteLength(JSON.stringify(entry)) < 2 * MiB));
      assert.equal(snapshot.entries.length, 4);
      if (checkpoint) {
        const restoredHost = capacityHost({ states: new Map(durable([...host.states])), forbidSend: true });
        const restored = capacityAssembly(restoredHost, { checkpoint, store: saves.replay(), entity: ModelExchanges.restore(snapshot), effects });
        try {
          assert.equal(await restored.runner.resume(saves.contextId), 'finished');
          assert.deepEqual(restoredHost.sent, []);
          assert.deepEqual(effects, ['0', '1', '2']);
          assert.deepEqual(restored.entity.snapshot(), snapshot);
        } finally {
          await closeCapacityHost(restoredHost);
        }
        const constrainedHost = capacityHost({ states: new Map(durable([...host.states])), forbidSend: true });
        const constrained = capacityAssembly(constrainedHost, { checkpoint, store: saves.replay(), entity: ModelExchanges.restore(snapshot), effects, recoveryLimits: { requestTextUnits: MiB, replyTextUnits: 2 * MiB } });
        try {
          await assert.rejects(constrained.runner.resume(saves.contextId));
          assert.deepEqual(constrainedHost.sent, []);
          assert.deepEqual(constrained.entity.snapshot(), snapshot);
          assert.deepEqual(effects, ['0', '1', '2']);
        } finally {
          await closeCapacityHost(constrainedHost);
        }
      }
    } finally {
      await closeCapacityHost(host);
    }
  });

test('cold recovery continues after a completed large request without repeating accepted tools or HTTP requests', async () => {
  const host = capacityHost({ rounds: 5 });
  const before = [];
  let fixture;
  let prefix;
  const saves = journal((commit, count) => {
    const snapshot = fixture.entity.snapshot();
    if (!prefix && commit.contract.key === 'capix.tool' && commit.point === 'tools' && snapshot.entries.length === 4 && snapshot.entries[3].feedback.length === 1) prefix = { count, entity: durable(snapshot), states: durable([...host.states]) };
  });
  fixture = capacityAssembly(host, { checkpoint: true, store: saves.store, effects: before });
  try {
    assert.equal(await fixture.runner.run(input), 'finished');
  } finally {
    await closeCapacityHost(host);
  }
  assert.ok(prefix);
  const after = [];
  const nextHost = capacityHost({ rounds: 5, states: new Map(prefix.states) });
  const restored = capacityAssembly(nextHost, { checkpoint: true, store: saves.replay(prefix.count), entity: ModelExchanges.restore(prefix.entity), effects: after });
  try {
    assert.equal(await restored.runner.resume(saves.contextId), 'finished');
    assert.deepEqual(before, ['0', '1', '2', '3', '4']);
    assert.deepEqual(after, ['4']);
    assert.deepEqual(
      nextHost.sent.map(({ turn }) => turn),
      [4, 5],
    );
    assert.deepEqual(
      nextHost.wire.map(({ turn }) => turn),
      [4, 5],
    );
    assert.ok(nextHost.sent.every(({ bytes }) => bytes > 2 * MiB));
    assert.deepEqual(restored.entity.snapshot().entries.slice(0, 4), prefix.entity.entries);
    assert.deepEqual(
      restored.entity.snapshot().entries.map(({ reply, feedback }) => ({ reply, feedback })),
      fixture.entity.snapshot().entries.map(({ reply, feedback }) => ({ reply, feedback })),
    );
  } finally {
    await closeCapacityHost(nextHost);
  }
});
