import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cuts, launch, studyDirectory } from './harness.mjs';

for (const mode of ['explicit', 'replay']) {
  for (const expected of cuts) {
    test(`${mode}: hard process exit at ${expected.cut}`, (t) => {
      const directory = studyDirectory(t);
      launch('run', directory, mode, { cut: expected.cut });
      const before = launch('inspect', directory, mode);
      const recovered = launch('resume', directory, mode);
      assert.equal(recovered.status, expected.status, JSON.stringify(recovered));
      assert.equal(recovered.world.counts.model ?? 0, expected.model);
      assert.equal(recovered.world.counts.entity ?? 0, expected.entity);
      assert.equal(recovered.world.counts.read ?? 0, 1);
      assert.equal(recovered.head.id, before.head.id);
      assert.deepEqual(
        recovered.commands.slice(0, before.commands.length).map((command) => command.id),
        before.commands.map((command) => command.id),
      );
      if (expected.status !== 'rejected') {
        const terminal = launch('resume', directory, mode);
        assert.equal(terminal.status, 'terminal');
        assert.deepEqual(terminal.commands, recovered.commands);
        assert.deepEqual(terminal.world.counts, recovered.world.counts);
      }
    });
  }

  test(`${mode}: a second crash during recovery does not reset evidence`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'model-effect' });
    launch('resume', directory, mode, { cut: 'entity-effect' });
    const result = launch('resume', directory, mode);
    assert.equal(result.status, 'completed');
    assert.equal(result.world.counts.model, 1);
    assert.equal(result.world.counts.entity, 1);
    assert.equal(result.world.counts.read, 1);
  });

  test(`${mode}: later source revisions do not replace an already recorded read`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'read-result' });
    const before = launch('inspect', directory, mode);
    const result = launch('resume', directory, mode, { source: 'new material' });
    assert.equal(result.status, 'completed');
    assert.equal(result.world.source, 'new material');
    assert.deepEqual(result.commands[0].outcome, before.commands[0].outcome);
    assert.equal(result.world.counts.read, 1);
    assert.ok(!JSON.stringify(result.result).includes('new material'));
  });

  test(`${mode}: committed acceptance skips the callback entirely`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'accepted' });
    const before = launch('inspect', directory, mode);
    const result = launch('resume', directory, mode);
    assert.equal(result.status, 'completed');
    assert.equal(result.world.counts.mapping, before.world.counts.mapping);
    assert.equal(result.world.counts.entity, before.world.counts.entity);
  });

  test(`${mode}: failed child not yet handled does not gain new recovery permission`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'child-returned', modelFailure: true });
    const result = launch('resume', directory, mode, { modelFailure: true });
    assert.equal(result.status, 'rejected');
    assert.equal(result.world.counts.model, 1);
    assert.equal(result.world.counts.entity ?? 0, 0);
  });

  test(`${mode}: handled result preserves the failed child and is not handled twice`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'accepted', modelFailure: true });
    const before = launch('inspect', directory, mode);
    const result = launch('resume', directory, mode, { modelFailure: true });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.commands[1], before.commands[1]);
    assert.equal(result.commands[1].outcome.returned.status, 'failed');
    assert.equal(result.commands[2].outcome.reception, 'handled');
    assert.equal(result.world.counts.mapping, 1);
    assert.equal(result.world.counts.model, 1);
  });

  for (const status of ['cancelled', 'failed']) {
    test(`${mode}: ${status} root is not revived by an available external receipt`, (t) => {
      const directory = studyDirectory(t);
      launch('run', directory, mode, { cut: 'model-effect' });
      launch('terminal', directory, mode, { status });
      const before = launch('inspect', directory, mode);
      const result = launch('resume', directory, mode);
      assert.equal(result.status, 'terminal');
      assert.equal(result.head.status, status);
      assert.deepEqual(result.world.counts, before.world.counts);
    });
  }

  test(`${mode}: incompatible policy is rejected before a new effect`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'read-result' });
    const result = launch('resume', directory, mode, { policyVersion: 'study@2' });
    assert.equal(result.status, 'rejected');
    assert.equal(result.world.counts.model ?? 0, 0);
  });

  test(`${mode}: missing root evidence cannot be silently reinitialized`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'model-effect' });
    launch('mutate', directory, mode, { deleteHead: true });
    const result = launch('resume', directory, mode);
    assert.equal(result.status, 'rejected');
    assert.equal(result.world.counts.model, 1);
    assert.equal(result.world.counts.entity ?? 0, 0);
  });
}
