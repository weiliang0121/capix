import assert from 'node:assert/strict';
import { test } from 'node:test';
import { count, cuts, launch, modes, studyDirectory } from './harness.mjs';

function deltas(report) {
  return report.events.filter((event) => event.kind === 'output' && event.value.kind === 'delta');
}

function assertFixedAppend(report) {
  assert.equal(report.transcript.revision, 1);
  assert.deepEqual(report.transcript.messages, [{ role: 'assistant', content: 'one: original material' }]);
  assert.equal(report.transcript.appends.length, 1);
  const fixed = report.transcript.appends[0];
  assert.deepEqual(fixed.request.operation, {
    parentContextId: report.heads.group.image.frame.owner.contextId,
    childContextId: report.heads.node.image.frame.owner.contextId,
    position: 'answer',
  });
  assert.deepEqual(fixed.request.messages, report.transcript.messages);
  assert.equal(fixed.receipt.transcriptId, report.transcript.id);
  assert.equal(count(report, 'entity-commit'), 1);
}

function assertOriginalCalls(before, after) {
  for (const level of ['scene', 'group', 'node']) {
    assert.deepEqual(after.heads[level].image.frame.owner, before.heads[level].image.frame.owner);
    assert.deepEqual(after.heads[level].image.frame.input, before.heads[level].image.frame.input);
  }
  assert.equal(after.heads.scene.image.frame.children.length, 1);
  assert.equal(after.heads.group.image.frame.children.length, 1);
  const entries = after.events.filter((event) => event.kind === 'entry' && event.fact.kind === 'requested');
  assert.deepEqual(
    entries.map((event) => event.fact.mode),
    ['run', 'resume'],
  );
  assert.notEqual(entries[0].entryId, entries[1].entryId);
}

function assertNoProtectedFallback(report) {
  assert.equal(count(report, 'fallback'), 0);
  const failed = report.events.filter((event) => event.kind === 'returned' && event.result.status === 'failed');
  assert.ok(failed.length > 0);
  assert.ok(failed.every((event) => event.result.failure?.receptionAllowed === false));
}

for (const mode of modes) {
  test(`${mode}: actual Group acceptance supplies the entity identity; windows expire`, (t) => {
    const directory = studyDirectory(t);
    const report = launch('run', directory, mode);
    assert.equal(report.status, 'succeeded');
    assertFixedAppend(report);
    for (const kind of ['node-body', 'resource-body', 'resource-cleanup', 'mapping', 'material-read', 'material-cleanup', 'coordinator-body', 'business-observed']) assert.equal(count(report, kind), 1, kind);
    assert.equal(count(report, 'stale-endpoint-allowed'), 0);
    assert.equal(count(report, 'stale-endpoint-rejected'), 2);
    assert.equal(deltas(report).length, 1);
    assert.equal(report.heads.group.image.frame.children[0].state.reception.kind, 'accepted');
    assert.equal(report.heads.scene.image.frame.children[0].state.reception.kind, 'accepted');
    const terminal = launch('resume', directory, mode);
    assert.equal(terminal.status, 'failed');
    assert.match(terminal.error.message, /terminal checkpoint/, 'actual Runner.resume must reject the terminal head');
    assert.equal(count(terminal, 'node-body'), 1);
    assert.equal(count(terminal, 'mapping'), 1);
    assert.equal(count(terminal, 'entity-commit'), 1);
  });

  for (const cut of cuts) {
    test(`${mode}: fresh-process resume after ${cut}`, (t) => {
      const directory = studyDirectory(t);
      launch('run', directory, mode, { cut });
      const before = launch('inspect', directory, mode);
      const report = launch('resume', directory, mode);
      const uncertain = ['preview-pending', 'preview-emitted'].includes(cut);
      assert.equal(report.status, uncertain ? 'failed' : 'succeeded', report.error?.message);
      assertOriginalCalls(before, report);
      assertFixedAppend(report);
      assert.equal(count(report, 'node-body'), 1);
      assert.equal(count(report, 'resource-body'), 1);
      assert.equal(count(report, 'resource-cleanup'), 1);
      assert.equal(count(report, 'material-read'), 1);
      assert.equal(count(report, 'mapping'), cut === 'entity-applied' ? 2 : 1);
      assert.equal(count(report, 'entity-applied'), cut === 'entity-applied' ? 2 : 1);
      assert.equal(count(report, 'fallback'), 0);
      assert.equal(count(report, 'stale-endpoint-allowed'), 0);
      const groupResumed = ['child-finish', 'entity-applied', 'group-accepted'].includes(cut);
      assert.equal(count(report, 'stale-endpoint-rejected'), ['child-finish', 'entity-applied'].includes(cut) ? 1 : 0, 'the newly opened waiting-resume endpoint must also expire');
      assert.equal(count(report, 'coordinator-body'), mode === 'replay' && groupResumed ? 2 : 1);
      assert.equal(deltas(report).length, cut === 'preview-pending' ? 0 : 1);
      if (uncertain) {
        assert.match(report.error.message, /Preview delivery is uncertain/);
        assert.equal(report.heads.scene.delivery.status, 'failed');
      } else {
        assert.equal(report.heads.scene.delivery.status, 'succeeded');
        assert.deepEqual(report.result.receipt, report.transcript.appends[0].receipt);
      }
    });
  }

  test(`${mode}: restoring from original input does not recapture changed external material`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'child-finish' });
    const report = launch('resume', directory, mode, { source: { revision: 2, text: 'changed material' } });
    assert.equal(report.status, 'succeeded');
    assert.equal(report.source.revision, 2);
    assert.equal(report.result.text, 'one: original material');
    assertFixedAppend(report);
    const captures = report.events.filter((event) => event.kind === 'capture');
    assert.equal(captures.length, 2, 'restored Group opens a new supply from decoded original input');
    assert.ok(captures.every((event) => event.material.revision === 1));
    assert.equal(count(report, 'material-read'), 1);
  });

  test(`${mode}: a saved child intention without its first CP never authorizes a replacement call`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'group-waiting' });
    const before = launch('inspect', directory, mode);
    assert.equal(before.heads.group.image.frame.children[0].state.kind, 'waiting');
    assert.equal(before.heads.node, undefined);
    const report = launch('resume', directory, mode);
    assert.equal(report.status, 'failed');
    assert.equal(report.heads.node, undefined);
    assert.equal(count(report, 'node-body'), 0);
    assert.equal(count(report, 'mapping'), 0);
    assert.equal(count(report, 'entity-commit'), 0);
    assert.equal(count(report, 'fallback'), 0);
    assert.deepEqual(report.heads.group.image.frame.children[0].identity, before.heads.group.image.frame.children[0].identity);
  });

  test(`${mode}: entity commit then another crash after acceptance does not append or map again`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'entity-applied' });
    launch('resume', directory, mode, { cut: 'group-accepted' });
    const before = launch('inspect', directory, mode);
    assert.equal(count(before, 'mapping'), 2);
    assertFixedAppend(before);
    const report = launch('resume', directory, mode);
    assert.equal(report.status, 'succeeded');
    assert.equal(count(report, 'mapping'), 2);
    assert.equal(count(report, 'resource-body'), 1);
    assertFixedAppend(report);
  });

  for (const fault of ['resource-close', 'child-finish-ack']) {
    test(`${mode}: ${fault} cannot become a successful parent fallback`, (t) => {
      const directory = studyDirectory(t);
      const report = launch('run', directory, mode, { fault });
      assert.equal(report.status, 'failed');
      assert.equal(count(report, 'resource-candidate'), 1);
      assert.equal(count(report, 'resource-cleanup'), 1);
      assert.equal(count(report, 'mapping'), 0);
      assert.equal(count(report, 'entity-commit'), 0);
      assert.equal(report.transcript.messages.length, 0);
      assert.equal(deltas(report).length, 0);
      assertNoProtectedFallback(report);
      if (fault === 'child-finish-ack') assert.equal(report.heads.node.delivery.status, 'succeeded', 'durable child success is not the same as successful live delivery');
      else assert.equal(report.heads.node, undefined, 'the cleanup failure occurs before the first child CP');
      assert.equal(report.heads.scene.delivery.status, 'failed');
      const terminal = launch('resume', directory, mode);
      assert.equal(terminal.status, 'failed');
      assert.match(terminal.error.message, /terminal checkpoint/);
      assert.equal(count(terminal, 'resource-body'), 1);
      assert.equal(count(terminal, 'fallback'), 0);
    });
  }

  test(`${mode}: strict observation fails after preview without rolling back the append`, (t) => {
    const report = launch('run', studyDirectory(t), mode, { fault: 'strict-observation' });
    assert.equal(report.status, 'failed');
    assert.equal(report.error.code, 'OBSERVATION_FAILED');
    assertFixedAppend(report);
    assert.equal(deltas(report).length, 1);
    assert.equal(count(report, 'business-observed'), 1);
    assert.equal(report.heads.scene.delivery.status, 'failed');
  });

  test(`${mode}: cancellation after preview retains content but cannot resurrect the root`, (t) => {
    const directory = studyDirectory(t);
    const report = launch('run', directory, mode, { fault: 'cancel-after-preview' });
    assert.equal(report.status, 'failed');
    assertFixedAppend(report);
    assert.equal(deltas(report).length, 1);
    assert.equal(report.heads.scene.delivery.status, 'cancelled');
    const terminal = launch('resume', directory, mode);
    assert.equal(terminal.status, 'failed');
    assert.match(terminal.error.message, /terminal checkpoint/);
    assert.equal(deltas(terminal).length, 1);
    assertFixedAppend(terminal);
  });

  test(`${mode}: required recovery activity failure blocks continuation, independently of business observation gap`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'child-finish' });
    const report = launch('resume', directory, mode, { fault: 'strict-checkpoint' });
    assert.equal(report.status, 'failed');
    assert.equal(report.error.code, 'OBSERVATION_FAILED');
    assert.equal(count(report, 'node-body'), 1);
    assert.equal(count(report, 'mapping'), 0);
    assert.equal(count(report, 'entity-commit'), 0);
    assert.equal(count(report, 'fallback'), 0);
    assert.equal(report.heads.scene.delivery.status, 'failed');
  });
}
