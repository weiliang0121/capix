import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const host = fileURLToPath(new URL('../examples/parallel-analysis/recovery/host.mjs', import.meta.url));

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-parallel-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'conversation.sqlite');
}

function execute(mode, path, variant, fault = 'none') {
  const child = spawnSync(process.execPath, [host, mode, path, variant, fault], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(child.error);
  assert.ok(child.stdout, `Missing ${mode} report: ${child.stderr}`);
  return { status: child.status, report: JSON.parse(child.stdout), stderr: child.stderr };
}

function capture(path, variant) {
  const stopped = execute('capture', path, variant);
  assert.equal(stopped.status, 73, JSON.stringify(stopped));
  const report = stopped.report;
  assert.deepEqual(report.counters, { primaryRuns: 1, primaryAccepted: variant === 'accepted' ? 1 : 0, primaryHandled: variant === 'handled' ? 1 : 0, secondaryAccepted: 0, mergeAccepted: 0, primaryRequests: 1, secondaryRequests: 1, mergeRequests: 0 });
  assert.equal(report.root.delivery, undefined);
  assert.equal(report.root.image.point, 'analyses');
  const [first, second] = report.root.image.frame.children;
  assert.deepEqual([first.key, second.key], ['primary', 'secondary']);
  assert.deepEqual([first.order, second.order], [0, 1]);
  assert.equal(first.state.kind, variant === 'accepted' ? 'returned' : 'failed');
  assert.equal(first.state.reception.kind, variant);
  assert.equal(second.state.kind, 'waiting');
  assert.equal(report.branch.image.point, 'reading');
  assert.equal(report.reader.image.point, 'waiting');
  assert.equal(report.reader.delivery, undefined);
  assert.deepEqual(report.reader.image.state, report.reference);
  assert.equal(report.interaction.id, report.reference.id);
  assert.equal(report.interaction.contract, report.reference.contract);
  assert.deepEqual(report.interaction.request, second.input);
  assert.equal(report.interaction.feedback.payload.text, 'B 保留测试时间。');
  assert.deepEqual(report.preview, [], 'analysis previews remain local');
  return report;
}

function successfulResume(path, variant, stopped) {
  const result = execute('resume', path, variant);
  assert.equal(result.status, 0, JSON.stringify(result));
  const resumed = result.report;
  assert.notEqual(resumed.pid, stopped.pid, 'restoration uses a different process, not live objects');
  assert.deepEqual(resumed.counters, { primaryRuns: 0, primaryAccepted: 0, primaryHandled: 0, secondaryAccepted: 1, mergeAccepted: 1, primaryRequests: 0, secondaryRequests: 0, mergeRequests: 1 });
  assert.equal(resumed.resumeEntered, true);
  assert.equal(resumed.root.delivery.status, 'succeeded');
  assert.equal(resumed.root.delivery.output, resumed.result);
  assert.deepEqual(resumed.preview, [resumed.result], 'only the newly executed merge emits a preview');
  assert.equal(resumed.root.image.point, 'completed');
  assert.deepEqual(resumed.root.image.frame.owner, stopped.root.image.frame.owner);
  assert.deepEqual(resumed.root.image.frame.input, stopped.root.image.frame.input);
  const [beforeA, beforeB] = stopped.root.image.frame.children;
  const [afterA, afterB, merge] = resumed.root.image.frame.children;
  assert.deepEqual(afterA, beforeA, 'accepted or handled A remains precisely the same fact');
  assert.deepEqual(afterB.identity, beforeB.identity);
  assert.deepEqual(afterB.input, beforeB.input);
  assert.equal(afterB.order, beforeB.order);
  assert.deepEqual(afterB.target, beforeB.target);
  assert.equal(afterB.state.kind, 'returned');
  assert.equal(afterB.state.reception.kind, 'accepted');
  assert.equal(merge.key, 'merge');
  assert.equal(merge.order, 2);
  assert.equal(merge.identity.parentContextId, stopped.root.image.frame.owner.contextId);
  assert.ok(![beforeA.identity.contextId, beforeB.identity.contextId].includes(merge.identity.contextId));
  assert.equal(merge.state.reception.kind, 'accepted');
  const input = JSON.parse(merge.input.messages.find((message) => message.role === 'user').content);
  assert.equal(input.primary.status, variant === 'handled' ? 'unavailable' : 'available');
  assert.equal(input.primary.material.index, 0);
  assert.equal(input.secondary.status, 'available');
  assert.equal(input.secondary.material.index, 2);
  assert.deepEqual(resumed.reference, stopped.reference);
  assert.deepEqual(resumed.interaction, stopped.interaction, 'reading persisted feedback does not mutate or redispatch the interaction');
  const installed = resumed.recoveryFacts.filter((fact) => fact.kind === 'installed').map((fact) => fact.contextId);
  assert.ok(installed.includes(beforeB.identity.contextId), 'B really enters restoration');
  assert.ok(!installed.includes(beforeA.identity.contextId), 'A is consumed as an accepted/handled fact');
  assert.ok(!resumed.recoveryFacts.some((fact) => fact.kind === 'child-restored' && fact.child?.identity.contextId === beforeA.identity.contextId), 'A receives no resume action');
  return resumed;
}

for (const variant of ['accepted', 'handled']) {
  test(`parallel ${variant} A and waiting B resume in another process without rerunning A or resending B`, (t) => {
    const path = database(t);
    const stopped = capture(path, variant);
    const resumed = successfulResume(path, variant, stopped);
    const terminal = execute('resume', path, variant);
    assert.equal(terminal.status, 1);
    assert.equal(terminal.report.error.code, 'EXAMPLE_RECOVERY_UNAVAILABLE');
    assert.equal(terminal.report.resumeEntered, false);
    assert.deepEqual(terminal.report.root, resumed.root, 'terminal result is not reopened');
    assert.ok(Object.values(terminal.report.counters).every((count) => count === 0));
  });

  for (const fault of ['missing-checkpoint', 'missing-feedback', 'wrong-feedback-request']) {
    test(`parallel ${variant} recovery rejects ${fault} before advancing its saved facts`, (t) => {
      const path = database(t);
      const stopped = capture(path, variant);
      const rejected = execute('resume', path, variant, fault);
      assert.equal(rejected.status, 1, JSON.stringify(rejected));
      assert.equal(rejected.report.error.code, 'EXAMPLE_RECOVERY_UNAVAILABLE');
      assert.equal(rejected.report.resumeEntered, false);
      assert.deepEqual(rejected.report.root, stopped.root, 'eligibility refusal must not finish or rewrite the parent CP');
      assert.deepEqual(rejected.report.branch, stopped.branch);
      assert.deepEqual(rejected.report.reader, stopped.reader);
      assert.deepEqual(rejected.report.interaction, stopped.interaction);
      assert.deepEqual(rejected.report.recoveryFacts, []);
      assert.ok(Object.values(rejected.report.counters).every((count) => count === 0));
      const inspected = execute('inspect', path, variant);
      assert.equal(inspected.status, 0);
      assert.deepEqual(inspected.report.root, stopped.root);
      successfulResume(path, variant, stopped);
    });
  }
}
