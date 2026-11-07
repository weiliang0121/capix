import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const fixture = fileURLToPath(new URL('./promise-recovery-process.mjs', import.meta.url));

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-resource-promise-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'facts.sqlite');
}

function invoke(mode, path, policy, rootId) {
  const child = spawnSync(process.execPath, [fixture, mode, path, policy, ...(rootId ? [rootId] : [])], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(child.error);
  assert.ok(child.stdout.trim(), child.stderr);
  return { exitCode: child.status, ...JSON.parse(child.stdout) };
}

function count(report, kind) {
  return report.events.filter((event) => event.kind === kind).length;
}

function cut(t, policy) {
  const path = database(t);
  const before = invoke('run', path, policy);
  assert.equal(before.exitCode, 73, JSON.stringify(before));
  assert.equal(before.root.delivery, undefined);
  assert.equal(before.root.image.point, 'receiving');
  assert.equal(before.root.image.frame.children[0].state.reception.kind, 'receiving');
  assert.equal(before.child.delivery.status, 'succeeded');
  assert.equal(before.effects.length, 1);
  assert.equal(count(before, 'resource-delivered'), 0);
  assert.equal(count(before, 'access-closed'), 0, 'Hard exit bypasses local finally');
  assert.equal(count(before, 'draft-created'), 1);
  assert.ok(!JSON.stringify(before.root).includes('local:'), 'Draft scratch does not enter checkpoint facts');
  return { path, before };
}

function unchangedChild(before, after) {
  assert.deepEqual(after.child, before.child);
  assert.equal(count(after, 'parent-body'), 1);
  assert.equal(count(after, 'child-body'), 1, 'Child body never repeats; receiver resource effects are a separate responsibility');
}

test('ordinary resource plus author receiver re-entry duplicates its effect despite exact Invocation recovery', (t) => {
  const { path, before } = cut(t, 'plain');
  const after = invoke('resume', path, 'plain', before.rootId);
  assert.equal(after.exitCode, 0, JSON.stringify(after));
  assert.equal(after.effects.length, 2, 'Negative control: CP cannot manufacture resource idempotence');
  assert.deepEqual(
    after.effects.map((effect) => JSON.parse(effect.body)),
    [{ text: 'one request' }, { text: 'one request' }],
  );
  assert.deepEqual(after.receipts, []);
  assert.equal(after.root.delivery.status, 'succeeded');
  assert.equal(after.result.id, 2);
  assert.equal(count(after, 'receiver-enter'), 2);
  assert.equal(count(after, 'resource-method'), 2);
  assert.equal(count(after, 'draft-created'), 2);
  const scratches = after.events.filter((event) => event.kind === 'draft-created').map((event) => event.scratch);
  assert.notEqual(scratches[0], scratches[1], 'Cold activity constructs a new local draft');
  assert.ok(!JSON.stringify(after.root).includes('local:'));
  unchangedChild(before, after);
});

test('explicit author refusal narrows recovery without calling an unconfirmable resource again', (t) => {
  const { path, before } = cut(t, 'refuse');
  const after = invoke('resume', path, 'refuse', before.rootId);
  assert.equal(after.exitCode, 1, JSON.stringify(after));
  assert.match(after.error.message, /Author refuses continuation/);
  assert.deepEqual(after.effects, before.effects);
  assert.equal(count(after, 'resource-method'), 1);
  assert.equal(count(after, 'receiver-enter'), 1);
  assert.equal(after.root.delivery.status, 'failed', 'Refusal after entering resume may finish the parent as failed');
  unchangedChild(before, after);
});

test('resource-owned exact confirmation extends the same receiving continuation without repeating effects', (t) => {
  const { path, before } = cut(t, 'confirmed');
  assert.equal(before.receipts.length, 1);
  const after = invoke('resume', path, 'confirmed', before.rootId);
  assert.equal(after.exitCode, 0, JSON.stringify(after));
  assert.deepEqual(after.effects, before.effects);
  assert.deepEqual(after.receipts, before.receipts);
  assert.equal(count(after, 'resource-confirmed'), 1);
  assert.equal(count(after, 'resource-committed'), 1);
  assert.equal(count(after, 'resource-method'), 2);
  assert.equal(count(after, 'receiver-enter'), 2);
  assert.equal(after.result.id, 1);
  assert.equal(after.root.image.frame.children[0].state.reception.kind, 'accepted');
  assert.equal(after.root.delivery.status, 'succeeded');
  unchangedChild(before, after);
  const terminal = invoke('resume', path, 'confirmed', before.rootId);
  assert.equal(terminal.exitCode, 1);
  assert.match(terminal.error.message, /terminal/i);
  assert.deepEqual(terminal.effects, after.effects);
  assert.deepEqual(terminal.events, after.events, 'Resource capability never revives a terminal invocation');
});

test('changed request under the original resource key is rejected without rolling back its prior effect', (t) => {
  const { path, before } = cut(t, 'changed-request');
  const after = invoke('resume', path, 'changed-request', before.rootId);
  assert.equal(after.exitCode, 1, JSON.stringify(after));
  assert.match(after.error.message, /Resource rejects a changed request/);
  assert.deepEqual(after.effects, before.effects);
  assert.deepEqual(after.receipts, before.receipts);
  assert.equal(count(after, 'resource-confirmed'), 0);
  assert.equal(after.root.delivery.status, 'failed');
  assert.equal(after.root.image.frame.children[0].state.reception.kind, 'receiving', 'Failed reception cannot fabricate a newer recoverable image');
  unchangedChild(before, after);
});

test('missing resource confirmation evidence refuses instead of inferring that no effect happened', (t) => {
  const { path, before } = cut(t, 'missing-receipt');
  const after = invoke('resume', path, 'missing-receipt', before.rootId);
  assert.equal(after.exitCode, 1, JSON.stringify(after));
  assert.match(after.error.message, /Resource confirmation evidence unavailable/);
  assert.deepEqual(after.effects, before.effects);
  assert.deepEqual(after.receipts, []);
  assert.equal(count(after, 'resource-committed'), 1);
  assert.equal(after.root.delivery.status, 'failed');
  unchangedChild(before, after);
});
