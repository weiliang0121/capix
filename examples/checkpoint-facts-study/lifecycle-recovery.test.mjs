import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const fixture = fileURLToPath(new URL('./lifecycle-recovery-process.mjs', import.meta.url));
function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-lifecycle-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'facts.sqlite');
}
function invoke(mode, path, variant = 'none', rootId) {
  const child = spawnSync(process.execPath, [fixture, mode, path, variant, ...(rootId ? [rootId] : [])], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(child.error);
  assert.ok(child.stdout.trim(), child.stderr);
  return { exitCode: child.status, ...JSON.parse(child.stdout) };
}
function count(result, kind) {
  return result.events.filter((event) => event.kind === kind).length;
}
function assertNoRepeatedBusiness(before, after) {
  for (const kind of ['parent-body', 'child-body', 'effect', 'accepted-mapping', 'handled-mapping']) assert.equal(count(after, kind), count(before, kind), kind);
}

for (const cut of ['waiting-no-child-head', 'child-failed', 'child-cancelled']) {
  test(`real public restoration rejects ${cut} from experiment fact storage`, (t) => {
    const path = database(t);
    const before = invoke('run', path, cut);
    assert.equal(before.exitCode, 73, JSON.stringify(before));
    assert.equal(before.root.delivery, undefined);
    assert.equal(before.root.image.frame.children[0].state.kind, 'waiting');
    const after = invoke('resume', path, 'none', before.rootId);
    assert.equal(after.exitCode, 1, JSON.stringify(after));
    assert.match(after.error.message, cut === 'waiting-no-child-head' ? /no durable continuation|unavailable/i : /[Ff]ailed or cancelled child cannot be resumed/);
    assertNoRepeatedBusiness(before, after);
    assert.equal(count(after, 'child-resume-created'), 0);
    assert.equal(count(after, 'child-resume'), 0);
  });
}

for (const [cut, childResumes] of [
  ['child-active', 1],
  ['child-succeeded', 0],
  ['lost-ack-parent-waiting', 0],
]) {
  test(`real public restoration continues ${cut} without redoing business or effects`, (t) => {
    const path = database(t);
    const before = invoke('run', path, cut);
    assert.equal(before.exitCode, 73, JSON.stringify(before));
    assert.equal(before.root.delivery, undefined);
    assert.equal(before.root.image.frame.children[0].state.kind, 'waiting');
    assert.equal(before.child.delivery?.status, cut === 'child-active' ? undefined : 'succeeded');
    const after = invoke('resume', path, 'none', before.rootId);
    assert.equal(after.exitCode, 0, JSON.stringify(after));
    assert.deepEqual(after.result, { answer: 'effect:one' });
    assert.equal(after.root.delivery.status, 'succeeded');
    assert.equal(after.child.delivery.status, 'succeeded');
    assert.equal(after.root.image.frame.owner.contextId, before.rootId);
    assert.equal(after.child.image.frame.owner.contextId, before.childId);
    assert.equal(count(after, 'parent-body'), 1);
    assert.equal(count(after, 'child-body'), 1);
    assert.equal(count(after, 'effect'), 1);
    assert.equal(count(after, 'accepted-mapping'), 1);
    assert.equal(count(after, 'child-resume-created'), childResumes);
    assert.equal(count(after, 'child-resume'), childResumes);
    const terminal = invoke('resume', path, 'none', before.rootId);
    assert.equal(terminal.exitCode, 1);
    assert.match(terminal.error.message, /terminal/i);
    assertNoRepeatedBusiness(after, terminal);
  });
}

for (const [cut, phase, answer] of [
  ['parent-accepted', 'accepted', 'effect:one'],
  ['parent-handled', 'handled', 'fallback'],
]) {
  test(`real cold ${phase} installation does not rerun an established parent mapping`, (t) => {
    const path = database(t);
    const before = invoke('run', path, cut);
    assert.equal(before.exitCode, 73, JSON.stringify(before));
    assert.equal(before.root.delivery, undefined);
    assert.equal(before.root.image.frame.children[0].state.reception.kind, phase);
    const after = invoke('resume', path, 'none', before.rootId);
    assert.equal(after.exitCode, 0, JSON.stringify(after));
    assert.deepEqual(after.result, { answer });
    assert.equal(after.root.delivery.status, 'succeeded');
    assertNoRepeatedBusiness(before, after);
    assert.equal(count(after, 'child-resume-created'), 0);
    assert.equal(count(after, 'child-resume'), 0);
    if (phase === 'handled') {
      assert.equal(after.child.delivery.status, 'failed');
      assert.equal(after.root.image.frame.children[0].state.kind, 'failed');
    }
  });
}

test('real cold receiving re-enters the original reception without repeating child work or its effect', (t) => {
  const path = database(t);
  const before = invoke('run', path, 'parent-receiving');
  assert.equal(before.exitCode, 73, JSON.stringify(before));
  assert.equal(before.root.delivery, undefined);
  assert.equal(before.root.image.frame.children[0].state.reception.kind, 'receiving');
  assert.deepEqual(before.root.image.frame.children[0].state.reception.contract, { position: 0 });
  assert.equal(before.child.delivery.status, 'succeeded');
  assert.equal(count(before, 'acceptance-begin'), 1);
  assert.equal(count(before, 'accepted-mapping'), 0);
  const after = invoke('resume', path, 'none', before.rootId);
  assert.equal(after.exitCode, 0, JSON.stringify(after));
  assert.deepEqual(after.result, { answer: 'effect:one' });
  assert.equal(after.root.delivery.status, 'succeeded');
  assert.equal(after.root.image.frame.children[0].state.reception.kind, 'accepted');
  assert.deepEqual(after.root.image.frame.children[0].state.reception.contract, { position: 0 });
  assert.equal(count(after, 'acceptance-begin'), 2, 'The interrupted pure receiver starts again');
  assert.equal(count(after, 'accepted-mapping'), 1);
  assert.equal(count(after, 'parent-body'), 1);
  assert.equal(count(after, 'child-body'), 1);
  assert.equal(count(after, 'effect'), 1);
  assert.equal(count(after, 'child-resume-created'), 0);
  assert.equal(count(after, 'child-resume'), 0);
});

test('real cold receiving rejects replacing its fixed reception with another registered contract', (t) => {
  const path = database(t);
  const before = invoke('run', path, 'parent-receiving');
  assert.equal(before.exitCode, 73, JSON.stringify(before));
  const after = invoke('resume', path, 'reception-contract', before.rootId);
  assert.equal(after.exitCode, 1, JSON.stringify(after));
  assert.match(after.error.message, /Restored reception contract cannot be replaced/);
  assertNoRepeatedBusiness(before, after);
  assert.equal(count(after, 'acceptance-begin'), 1, 'The replacement receiver never starts');
  assert.equal(count(after, 'accepted-mapping'), 0);
  assert.equal(count(after, 'child-resume-created'), 0);
  assert.equal(count(after, 'child-resume'), 0);
  assert.deepEqual(after.child, before.child);
  assert.equal(after.root.image.frame.children[0].state.reception.kind, 'receiving');
  assert.deepEqual(after.root.image.frame.children[0].state.reception.contract, { position: 0 });
});

for (const [cut, expectedExit, status] of [
  ['root-terminal', 0, 'succeeded'],
  ['lost-ack-parent-failed', 73, 'failed'],
]) {
  test(`real terminal ${status} root cannot be revived from experiment fact storage`, (t) => {
    const path = database(t);
    const before = invoke('run', path, cut);
    assert.equal(before.exitCode, expectedExit, JSON.stringify(before));
    assert.equal(before.root.delivery.status, status);
    const after = invoke('resume', path, 'none', before.rootId);
    assert.equal(after.exitCode, 1);
    assert.match(after.error.message, /terminal/i);
    assert.deepEqual(after.root, before.root);
    assert.deepEqual(after.child, before.child);
    assert.deepEqual(after.events, before.events, 'Terminal preflight fails before any author work or persistence');
  });
}

for (const variant of ['child-owner', 'child-input', 'child-contract', 'root-order', 'root-refs']) {
  test(`real public recovery rejects adversarial ${variant} without new child work`, (t) => {
    const path = database(t);
    const before = invoke('run', path, 'child-succeeded');
    assert.equal(before.exitCode, 73, JSON.stringify(before));
    const after = invoke('resume', path, variant, before.rootId);
    assert.equal(after.exitCode, 1, JSON.stringify(after));
    assert.match(after.error.message, variant === 'root-order' ? /invalid child identity, declaration position or order/ : variant === 'root-refs' ? /child reference differs/ : /Child checkpoint differs from parent-owned identity/);
    assertNoRepeatedBusiness(before, after);
    assert.equal(count(after, 'child-resume-created'), 0);
    assert.equal(count(after, 'child-resume'), 0);
    assert.deepEqual(after.child, before.child, 'Adversarial reads never rewrite the original child evidence');
  });
}
