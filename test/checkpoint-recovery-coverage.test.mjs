import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/tool-checkpoint-matrix.mjs', import.meta.url));
const policies = ['baseline', 'final', 'rejected', 'final,rejected'];
const cuts = ['dispatch-success', 'effect-after', 'child-success', 'feedback-success', 'accepted-success', 'dispatch-failure', 'child-failure', 'feedback-failure', 'handled-failure', 'rejected-feedback', 'rejected-checkpoint', 'final-feedback', 'final-processing', 'completed'];
const baselineRefusals = new Set(['dispatch-success', 'dispatch-failure', 'child-failure', 'feedback-failure']);
function database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'capix-cp-coverage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'conversation.sqlite');
}
function run(mode, path, policy, cut = 'none') {
  const child = spawnSync(process.execPath, [fixture, mode, path, policy, cut], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(child.error);
  assert.ok(child.stdout.trim(), child.stderr);
  return { status: child.status, ...JSON.parse(child.stdout) };
}
function crash(path, policy, cut) {
  const value = run('crash', path, policy, cut);
  assert.equal(value.status, 73, JSON.stringify(value));
  assert.equal(value.halted, cut);
  assert.equal(value.roots[0].status, 'pending', 'hard exit must not run normal failure/finally cleanup');
  return value;
}
function count(report, kind) {
  return report.events.filter((event) => event.kind === kind).length;
}
function completed(report) {
  assert.equal(report.status, 0, JSON.stringify(report.error));
  assert.equal(report.result, 'matrix complete');
  assert.deepEqual(report.requests, ['tools', 'final']);
  assert.equal(report.effects.length, 1, 'one actual business effect, not merely one tool feedback');
  assert.equal(count(report, 'failure-attempt'), 1, 'a failed tool is not restarted');
  assert.equal(report.exchanges.length, 2);
  assert.deepEqual(
    report.exchanges[0].feedback.map((item) => [item.toolCallId, item.status]),
    [
      ['effect-1', 'ok'],
      ['failure-1', 'error'],
      ['rejected-1', 'error'],
    ],
  );
  assert.equal(report.exchanges[0].receptions.length, 2);
  const effect = report.loop.children.find((child) => child.key === 'effect-1');
  const failure = report.loop.children.find((child) => child.key === 'failure-1');
  assert.equal(effect.identity.contextId, report.effects[0].contextId);
  assert.equal(effect.state.kind, 'returned');
  assert.equal(effect.state.reception.kind, 'accepted');
  assert.equal(failure.state.kind, 'failed');
  assert.equal(failure.state.reception.kind, 'handled');
  for (const [key, child] of [
    ['effect-1', effect],
    ['failure-1', failure],
  ]) {
    const receipt = report.exchanges[0].receptions.find((item) => item.callId === key);
    assert.equal(receipt.operation.childContextId, child.identity.contextId);
    assert.equal(receipt.operation.parentContextId, child.identity.parentContextId);
    assert.deepEqual(child.state.reception.output.operation, receipt.operation);
  }
  assert.equal(report.roots[0].status, 'succeeded');
}
function refused(before, after) {
  assert.equal(after.status, 1);
  assert.ok(after.error?.message);
  // Failure cleanup may finish CPs. Business facts must remain unchanged.
  assert.deepEqual(after.requests, before.requests);
  assert.deepEqual(after.effects, before.effects);
  assert.deepEqual(after.exchanges, before.exchanges);
  assert.deepEqual(after.mappings, before.mappings);
  assert.equal(count(after, 'failure-attempt'), count(before, 'failure-attempt'));
}

for (const policy of policies) {
  test(`recovery profile ${policy}: uninterrupted exact delivery and save count`, (t) => {
    const report = run('run', database(t), policy);
    completed(report);
    assert.deepEqual(report.mappings, ['success', 'failure']);
    const removed = policy === 'baseline' ? 0 : policy.split(',').length;
    assert.equal(report.saveCount, 18 - removed);
    assert.equal(report.events.filter((event) => event.kind === 'save' && event.contract === 'conversation.tools.loop').length, 10 - removed);
    assert.equal(report.skippedCount, removed);
  });
  for (const cut of cuts) {
    test(`recovery profile ${policy}: real process loss at ${cut}`, (t) => {
      const path = database(t);
      const before = crash(path, policy, cut);
      const after = run('resume', path, policy);
      if (baselineRefusals.has(cut)) {
        refused(before, after);
        assert.match(after.error.message, cut.startsWith('dispatch') ? /no durable continuation/ : /Failed or cancelled child/);
      } else {
        completed(after);
        assert.deepEqual(after.mappings, cut === 'feedback-success' ? ['success', 'success', 'failure'] : ['success', 'failure']);
      }
    });
  }
  test(`recovery profile ${policy}: repeated crashes keep the same schedule and fixed effects`, (t) => {
    const path = database(t);
    crash(path, policy, 'effect-after');
    for (const cut of ['rejected-checkpoint', 'final-processing']) {
      const next = run('resume-crash', path, policy, cut);
      assert.equal(next.status, 73, JSON.stringify(next));
      assert.equal(next.halted, cut);
      assert.equal(next.effects.length, 1);
      if (policy.includes('rejected')) assert.ok(next.events.some((event) => event.kind === 'skip' && event.omission === 'rejected'));
      if (policy.includes('final') && cut === 'final-processing') assert.ok(next.events.some((event) => event.kind === 'skip' && event.omission === 'final'));
    }
    const after = run('resume', path, policy);
    completed(after);
    assert.deepEqual(after.mappings, ['success', 'failure']);
    const terminal = run('resume', path, policy);
    refused(after, terminal);
  });
}

for (const policy of ['success', 'final,rejected,success']) {
  test(`removing successful reception (${policy}) preserves effects but expands mapping replay`, (t) => {
    const path = database(t);
    const before = crash(path, policy, 'accepted-success');
    assert.deepEqual(before.mappings, ['success']);
    const after = run('resume', path, policy);
    completed(after);
    assert.deepEqual(after.mappings, ['success', 'success', 'failure']);
  });
}
for (const policy of ['handled', 'final,rejected,handled']) {
  for (const cut of ['handled-failure', 'rejected-feedback']) {
    test(`removing handled reception (${policy}) loses baseline recovery at ${cut}`, (t) => {
      const path = database(t);
      const before = crash(path, policy, cut);
      const after = run('resume', path, policy);
      refused(before, after);
      assert.match(after.error.message, /Failed or cancelled child/);
    });
  }
}
for (const policy of ['dispatch', 'batch', 'final,rejected,dispatch']) {
  for (const cut of ['effect-after', 'child-success']) {
    test(`unsafe profile ${policy}: ${cut} duplicates an effect without an owned dispatch ref`, (t) => {
      const path = database(t);
      const before = crash(path, policy, cut);
      assert.equal(before.effects.length, 1);
      const after = run('resume', path, policy);
      assert.equal(after.status, 0, JSON.stringify(after.error));
      assert.equal(after.effects.length, 2, 'this negative example must not be mislabeled safe refusal');
      assert.notEqual(after.effects[0].contextId, after.effects[1].contextId);
      assert.equal(after.effects[0].key, after.effects[1].key);
      assert.deepEqual(after.requests, ['tools', 'final'], 'the model was not resent, yet tool effects repeated');
    });
  }
  test(`unsafe profile ${policy}: an existing feedback detects missing ownership only after its commit`, (t) => {
    const path = database(t);
    const before = crash(path, policy, 'feedback-success');
    const after = run('resume', path, policy);
    refused(before, after);
    assert.match(after.error.message, /Feedback has no exact tool child/);
  });
}
test('removing dispatch can also restart a failed tool before its feedback is persisted', (t) => {
  const path = database(t);
  const before = crash(path, 'dispatch', 'child-failure');
  assert.equal(count(before, 'failure-attempt'), 1);
  const after = run('resume', path, 'dispatch');
  assert.equal(after.status, 0);
  assert.equal(count(after, 'failure-attempt'), 2);
  assert.equal(after.effects.length, 1);
});
