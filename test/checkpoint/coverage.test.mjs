import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./coverage.fixture.mjs', import.meta.url));
function invoke(path, mode, boundary, scenario) {
  return spawnSync(process.execPath, [fixture, path, mode, boundary, scenario], { encoding: 'utf8', timeout: 15000 });
}
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-cp-coverage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'observer.sqlite');
}
const boundaries = ['selectionResult', 'selectionAccepted', 'understandingFeedback', 'decisionResult', 'decisionAccepted', 'preflightResult', 'preflightAccepted', 'readResult', 'interactionFeedback', 'answerFeedback', 'answerCommitted', 'answerAccepted', 'filePrepared', 'fileCommitted', 'fileAccepted', 'memoryFeedback', 'memoryPrepared', 'memoryCommitted', 'completed'];
for (const boundary of boundaries)
  test(`file conversation continues ${boundary} through accepted file and memory effects exactly once`, (t) => {
    const path = setup(t);
    const first = invoke(path, 'start', boundary, 'file');
    assert.equal(first.status, 75, first.stdout + first.stderr);
    const next = invoke(path, boundary === 'readResult' ? 'changedFile' : 'restore', boundary, 'file');
    assert.equal(next.status, 0, next.stderr);
    const result = JSON.parse(next.stdout);
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.equal(result.result.content, '整理后的正文。');
    assert.deepEqual(
      result.calls.map((call) => call.purpose),
      ['selection', 'understanding', 'answer', 'memory'],
    );
    assert.equal(result.transcript.messages.length, 2);
    assert.equal(result.transcript.appends.length, 1);
    assert.equal(result.file, '整理后的正文。');
    assert.equal(result.memories.sequence, 1);
    assert.equal(result.memories.items.length, 1);
    assert.equal(result.memories.applies.length, 1);
    assert.equal(result.root.status, 'succeeded');
    assert.ok(
      result.observation.some((activity) => activity.contextId === result.rootContextId && activity.recovering),
      'the resumed root has a new recovery activity',
    );
    assert.ok(
      result.observation.every((activity) => activity.rootContextId === result.rootContextId && activity.recovering),
      'continued work and new descendants belong to the original root and recovery chain',
    );
  });
for (const boundary of ['decisionResult', 'answerCommitted', 'decisionAccepted'])
  test(`clarification continues ${boundary} without duplicating the assistant message`, (t) => {
    const path = setup(t);
    const first = invoke(path, 'start', boundary, 'clarify');
    assert.equal(first.status, 75, first.stdout + first.stderr);
    const next = invoke(path, 'restore', boundary, 'clarify');
    assert.equal(next.status, 0, next.stderr);
    const result = JSON.parse(next.stdout);
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.equal(result.result.kind, 'needs-info');
    assert.equal(result.transcript.messages.length, 2);
    assert.equal(result.transcript.appends.length, 1);
    assert.deepEqual(
      result.calls.map((call) => call.purpose),
      ['selection', 'understanding'],
    );
  });
test('second generation continues the saved second model result without a third model request', (t) => {
  const path = setup(t);
  const first = invoke(path, 'start', 'answerFeedback', 'regeneration');
  assert.equal(first.status, 75, first.stdout + first.stderr);
  const next = invoke(path, 'restore', 'answerFeedback', 'regeneration');
  assert.equal(next.status, 0, next.stderr);
  const result = JSON.parse(next.stdout);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.deepEqual(
    result.calls.map((call) => call.purpose),
    ['selection', 'answer', 'answer', 'memory'],
  );
  assert.equal(result.transcript.messages.length, 2);
});
test('unconfirmed file publication is not retried or promoted to a saved result', (t) => {
  const path = setup(t);
  const first = invoke(path, 'start', 'filePending', 'file');
  assert.equal(first.status, 75, first.stdout + first.stderr);
  const next = invoke(path, 'restore', 'filePending', 'file');
  assert.equal(next.status, 0, next.stderr);
  const result = JSON.parse(next.stdout);
  assert.equal(result.error.code, 'FILE_CREATION_UNCONFIRMED');
  assert.equal(result.file, null);
  assert.deepEqual(
    result.calls.map((call) => call.purpose),
    ['selection', 'understanding', 'answer'],
  );
});
