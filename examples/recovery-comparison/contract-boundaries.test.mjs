import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launch, studyDirectory } from './harness.mjs';

for (const mode of ['explicit', 'replay']) {
  for (const variant of ['changedModelInput', 'changedModelName']) {
    test(`${mode}: existing child evidence rejects ${variant}`, (t) => {
      const directory = studyDirectory(t);
      launch('run', directory, mode, { cut: 'child-returned' });
      const result = launch('resume', directory, mode, { [variant]: true });
      assert.equal(result.status, 'rejected');
      assert.equal(result.world.counts.model, 1);
      assert.equal(result.world.counts.entity ?? 0, 0);
    });
  }

  test(`${mode}: changed acceptance cannot confirm a different already committed effect`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'entity-effect' });
    const result = launch('resume', directory, mode, { mappingSuffix: ' changed' });
    assert.equal(result.status, 'rejected');
    assert.equal(result.world.counts.entity, 1);
    assert.equal(result.world.counts.model, 1);
  });

  test(`${mode}: matching cannot detect undeclared mapping drift beyond the recorded frontier`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'child-returned' });
    // Deliberately violate the semantic policy-version discipline. No durable
    // acceptance or external write exists yet to reveal this changed closure.
    const result = launch('resume', directory, mode, { mappingSuffix: ' UNVERSIONED CHANGE' });
    assert.equal(result.status, 'completed');
    assert.ok(JSON.stringify(result.result).includes('UNVERSIONED CHANGE'));
    assert.equal(result.world.counts.model, 1);
    assert.equal(result.world.counts.entity, 1);
  });

  test(`${mode}: current source is allowed before the first observation has happened`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'initial' });
    const result = launch('resume', directory, mode, { source: 'fresh-before-first-read' });
    assert.equal(result.status, 'completed');
    assert.ok(JSON.stringify(result.result).includes('fresh-before-first-read'));
  });

  test(`${mode}: lost exact model receipt is unknown rather than permission to resend`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'model-effect' });
    launch('mutate', directory, mode, { deleteReceipt: 'model' });
    const result = launch('resume', directory, mode);
    assert.equal(result.status, 'rejected');
    assert.equal(result.world.counts.model, 1);
    assert.equal(result.world.counts.entity ?? 0, 0);
  });

  test(`${mode}: a missing command suffix is not a new unexecuted frontier`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'child-returned' });
    const before = launch('inspect', directory, mode);
    launch('mutate', directory, mode, { deleteCommandsFrom: 2 });
    const result = launch('resume', directory, mode);
    assert.equal(result.status, 'rejected');
    assert.match(result.error, /history suffix/);
    assert.deepEqual(result.world.counts, before.world.counts);
    assert.equal(result.metrics.authorEntries, before.metrics.authorEntries);
  });

  for (const field of ['owner', 'input', 'name', 'policyVersion']) {
    test(`${mode}: corrupted command ${field} is rejected before further effects`, (t) => {
      const directory = studyDirectory(t);
      launch('run', directory, mode, { cut: 'child-returned' });
      launch('mutate', directory, mode, { command: { ordinal: 2, field, value: field === 'input' ? { corrupt: true } : 'corrupt' } });
      const result = launch('resume', directory, mode);
      assert.equal(result.status, 'rejected');
      assert.equal(result.world.counts.entity ?? 0, 0);
    });
  }
}

test('replay: early return may not silently omit a recorded command suffix', (t) => {
  const directory = studyDirectory(t);
  launch('run', directory, 'replay', { cut: 'child-returned' });
  const result = launch('resume', directory, 'replay', { omitModel: true });
  assert.equal(result.status, 'rejected');
  assert.equal(result.world.counts.entity ?? 0, 0);
});

test('negative control: code outside controlled boundaries repeats when the coordinator replays', (t) => {
  const observed = {};
  for (const mode of ['explicit', 'replay']) {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'model-effect', unsafeOutside: true });
    const result = launch('resume', directory, mode, { unsafeOutside: true });
    assert.equal(result.status, 'completed');
    assert.equal(result.world.counts.model, 1);
    assert.equal(result.world.counts.entity, 1);
    observed[mode] = result.world.counts.outside;
  }
  assert.deepEqual(observed, { explicit: 1, replay: 2 });
});

test('negative control: explicit resume also repeats unsafe code inside an unfinished segment', (t) => {
  for (const mode of ['explicit', 'replay']) {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'read-result', unsafeOutside: true });
    const result = launch('resume', directory, mode, { unsafeOutside: true });
    assert.equal(result.status, 'completed');
    assert.equal(result.world.counts.read, 1);
    assert.equal(result.world.counts.outside, 2);
  }
});
