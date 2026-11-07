import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launch, studyDirectory } from './harness.mjs';

for (const mode of ['explicit', 'replay']) {
  for (const field of ['input', 'name', 'member', 'kind']) {
    test(`${mode}: late cold validation rejects corrupted historical model ${field}`, (t) => {
      const directory = studyDirectory(t);
      launch('run', directory, mode, { cut: 'accepted' });
      const before = launch('inspect', directory, mode);
      launch('mutate', directory, mode, { command: { ordinal: 2, field, value: field === 'input' ? { corrupt: true } : 'corrupt' } });
      const result = launch('resume', directory, mode);
      assert.equal(result.status, 'rejected');
      assert.deepEqual(result.world.counts, before.world.counts, 'Cold rejection must precede author callbacks and effects');
      assert.equal(result.metrics.authorEntries, before.metrics.authorEntries);
    });
  }

  test(`${mode}: late cold validation checks the original read against the root input`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'accepted' });
    launch('mutate', directory, mode, { command: { ordinal: 1, field: 'input', value: { query: 'corrupt' } } });
    const result = launch('resume', directory, mode);
    assert.equal(result.status, 'rejected');
    assert.equal(result.world.counts.entity, 1);
  });

  test(`${mode}: reception must retain the exact child delivery`, (t) => {
    const directory = studyDirectory(t);
    launch('run', directory, mode, { cut: 'accepted' });
    const before = launch('inspect', directory, mode);
    const delivery = before.commands[2].input;
    launch('mutate', directory, mode, { command: { ordinal: 3, field: 'input', value: { ...delivery, childId: 'foreign' } } });
    const result = launch('resume', directory, mode);
    assert.equal(result.status, 'rejected');
    assert.deepEqual(result.world.counts, before.world.counts);
  });

  for (const modelFailure of [false, true]) {
    test(`${mode}: cold validation keeps returned and ${modelFailure ? 'handled' : 'accepted'} distinct`, (t) => {
      const directory = studyDirectory(t);
      launch('run', directory, mode, { cut: 'accepted', modelFailure });
      const before = launch('inspect', directory, mode);
      const outcome = before.commands[2].outcome;
      launch('mutate', directory, mode, { command: { ordinal: 3, field: 'outcome', value: { ...outcome, reception: modelFailure ? 'accepted' : 'handled' } } });
      const result = launch('resume', directory, mode);
      assert.equal(result.status, 'rejected');
      assert.deepEqual(result.world.counts, before.world.counts);
    });
  }

  for (const variant of ['changedModelInput', 'changedModelName']) {
    test(`${mode}: unversioned change to already passed code is separate from history corruption (${variant})`, (t) => {
      const directory = studyDirectory(t);
      launch('run', directory, mode, { cut: 'accepted' });
      const before = launch('inspect', directory, mode);
      const result = launch('resume', directory, mode, { [variant]: true });
      assert.equal(result.status, mode === 'explicit' ? 'completed' : 'rejected');
      assert.deepEqual(result.commands, before.commands, 'Current code switches must not rewrite the valid old evidence');
      assert.deepEqual(result.world.counts, before.world.counts);
    });
  }
}
