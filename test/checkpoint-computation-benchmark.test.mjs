import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { material, runSample } from '../examples/checkpoint-computation/fixture.mjs';

const base = { mode: 'timing', store: 'memory', family: 'growth', n: 3, inputBytes: 1024, valueBytes: 64, refs: 'current' };

test('benchmark timing preserves real three-layer saves and keeps no diagnostic bytes', async () => {
  const value = await runSample(base);
  assert.equal(value.status, 'completed', JSON.stringify(value.error));
  assert.equal(value.result, 3);
  assert.deepEqual(value.stores.byOwner, { scene: { saves: 1, finishes: 1 }, group: { saves: 7, finishes: 1 }, node: { saves: 3, finishes: 3 } });
  assert.equal(value.samples.length, 11);
  for (const sample of value.samples) {
    assert.equal(sample.succeeded, true);
    assert.equal(sample.storeCalls, 1);
    assert.ok(sample.checkpointMs >= sample.storeMs);
    assert.equal('fieldBytes' in sample, false);
    assert.equal('codecCalls' in sample, false);
  }
  const accepted = value.samples.filter((sample) => sample.owner === 'group' && sample.point === 'accepted');
  assert.deepEqual(
    accepted.map((sample) => [sample.n, sample.r, sample.a]),
    [
      [1, 1, 0],
      [2, 1, 0],
      [3, 1, 0],
    ],
  );
  assert.equal(value.diagnostic, null);
});

test('benchmark diagnostics count new facts and indexed refs without changing outcomes', async () => {
  const current = await runSample({ ...base, mode: 'diagnostic' });
  const all = await runSample({ ...base, mode: 'diagnostic', refs: 'all' });
  assert.equal(current.status, 'completed');
  assert.equal(all.status, 'completed');
  assert.equal(current.result, all.result);
  assert.deepEqual(current.stores.byOwner, all.stores.byOwner);
  const last = all.samples.findLast((sample) => sample.owner === 'group' && sample.point === 'accepted');
  assert.equal(last.n, 3);
  assert.equal(last.r, 3);
  assert.equal(last.representation, 'delta');
  assert.equal(last.inferredReferenceComparisons, 6);
  assert.equal(last.relationEntries, 1);
  assert.equal(last.fieldBytes.input, 0);
  assert.equal(last.fieldBytes.currentInput, 0);
  assert.ok(last.imageBytes > last.fieldBytes.input);
  assert.equal(last.codecCalls['group.input.encode'] ?? 0, 0);
  assert.equal(last.codecCalls['group.check'], 1);
  assert.equal(last.codecCalls['node.input.encode'] ?? 0, 0);
  assert.equal(last.codecCalls['node.output.encode'], 1);
  assert.equal(last.codecCalls['reception.output.encode'], 1);
  assert.equal(last.codecCalls['reception.check'], 1);
  assert.equal(last.checkpointMs, null);
  assert.equal(last.storeMs, null);
});

for (const n of [0, 3])
  test(`fixed-input benchmark publishes input once and only current state/refs thereafter at n=${n}`, async () => {
    const value = await runSample({ ...base, mode: 'diagnostic', family: 'input', n });
    assert.equal(value.status, 'completed', JSON.stringify(value.error));
    assert.equal(value.result, n);
    const samples = value.samples.filter((sample) => sample.owner === 'group');
    assert.equal(samples.length, 16);
    assert.equal(value.stores.byOwner.group.saves, 16);
    assert.ok(samples.every((sample) => sample.point === 'diagnostic' && sample.n === n && sample.r === (n ? 1 : 0)));
    assert.equal(samples[0].fieldBytes.input, base.inputBytes + 2);
    assert.equal(samples[0].relationEntries, n);
    assert.equal(samples[0].codecCalls['group.input.encode'], 1);
    assert.equal(samples[0].codecCalls['node.output.encode'] ?? 0, n);
    for (const sample of samples.slice(1)) {
      assert.equal(sample.representation, 'delta');
      assert.equal(sample.fieldBytes.input, 0);
      assert.equal(sample.fieldBytes.currentInput, 0);
      assert.equal(sample.relationEntries, 0);
      assert.deepEqual(sample.codecCalls, { 'group.state.encode': 1, 'group.state.decode': 1, 'group.check': 1 });
    }
    assert.deepEqual(
      samples.slice(1).map((sample) => sample.fieldBytes),
      Array.from({ length: 15 }, () => samples[1].fieldBytes),
    );
  });

test('control mode removes saving timers but retains the real outcome and Store counts', async () => {
  const value = await runSample({ ...base, mode: 'control' });
  assert.equal(value.status, 'completed');
  assert.equal(value.result, 3);
  assert.equal(value.samples.length, 0);
  assert.equal(value.stores.saveCount, 11);
  assert.equal(value.stores.finishCount, 5);
  assert.ok(value.stores.finishes.every((entry) => entry.elapsedMs === null));
});

test('SQLite benchmark closes the writer before inspecting its real persisted heads', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'capix-computation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'sample.sqlite');
  const value = await runSample({ ...base, store: 'sqlite', n: 2 }, { path });
  assert.equal(value.status, 'completed', JSON.stringify(value.error));
  assert.equal(value.storage.imageIdentities, 8);
  assert.equal(value.storage.retainedBodies, 4);
  assert.equal(value.storage.heads, 4);
  assert.ok(value.storage.bodyBytes > 0);
  assert.ok(value.storageBeforeClose.walBytes > 0);
  await assert.rejects(runSample({ ...base, store: 'sqlite' }, { path }), /new database/);
});

test('seeded fixture text has exact UTF-8 bytes and stable independently generated content', () => {
  assert.equal(Buffer.byteLength(material(512)), 512);
  assert.equal(material(512), material(512));
  assert.notEqual(material(512), material(512, 'seeded', 8));
  assert.equal(material(5, 'repeat'), 'xxxxx');
});

test('a pre-Store size refusal remains a failed timed sample, not a zero-byte success', async () => {
  const value = await runSample({ ...base, family: 'input', n: 0, inputBytes: 8 * 1024 * 1024, pattern: 'repeat' });
  assert.equal(value.status, 'failed');
  assert.equal(value.result, null);
  const failed = value.samples.find((sample) => sample.owner === 'scene' && !sample.succeeded);
  assert.equal(failed.point, 'waiting');
  assert.equal(failed.storeCalls, 0);
  assert.ok(failed.checkpointMs > 0);
  assert.equal(failed.imageBytes, undefined);
  assert.ok(value.error.causes.some((cause) => /limit exceeded/.test(cause.message)));
  assert.equal(value.lastCompletedStep, 0);
});

test('a smaller physical delta cannot admit an oversized complete logical image', async () => {
  const value = await runSample({ ...base, family: 'input', n: 0, inputBytes: 4 * 1024 * 1024, pattern: 'repeat' });
  assert.equal(value.status, 'failed');
  assert.equal(value.result, null);
  const failed = value.samples.find((sample) => sample.owner === 'group' && !sample.succeeded);
  assert.equal(failed.point, 'diagnostic');
  assert.equal(failed.storeCalls, 1, 'complete logical accounting is enforced at the incremental Store boundary');
  assert.equal(value.stores.byOwner.group, undefined, 'the rejected candidate did not publish a group head');
  assert.equal(value.lastCompletedStep, 0);
  assert.ok(value.error.causes.some((cause) => /logical image exceeds/.test(cause.message)));
});
