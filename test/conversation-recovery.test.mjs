import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/conversation-recovery.mjs', import.meta.url));

function run(mode, database, boundary) {
  const child = spawnSync(process.execPath, [fixture, mode, database, ...(boundary ? [boundary] : [])], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error);
  assert.ok(child.stdout, `${mode} produced no report: ${child.stderr}`);
  return { status: child.status, report: JSON.parse(child.stdout), stderr: child.stderr };
}

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-conversation-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'conversation.sqlite');
}

function requests(path) {
  return readFileSync(`${path}.requests`, 'utf8').trim().split('\n');
}

for (const boundary of ['materials', 'feedback', 'assistant', 'memory']) {
  test(`a new process resumes after durable ${boundary} without repeating completed requests or effects`, (t) => {
    const path = database(t);
    const stopped = run('crash', path, boundary);
    assert.equal(stopped.status, 73, JSON.stringify(stopped.report));
    assert.equal(stopped.report.state.transcript.messages.length, boundary === 'feedback' || boundary === 'materials' ? 1 : 2);
    assert.equal(stopped.report.state.memories.items.length, boundary === 'memory' ? 1 : 0);
    if (boundary === 'memory')
      assert.equal(
        stopped.report.state.view.members.some((member) => member.source === 'memories'),
        false,
        'memory commit preceded View membership',
      );
    const resumed = run('resume', path);
    assert.equal(resumed.status, 0, JSON.stringify(resumed.report));
    assert.equal(resumed.report.result, '好的，后续我会使用简短的中文回答。');
    const state = resumed.report.state;
    assert.equal(state.transcript.messages.length, 2);
    assert.equal(state.transcript.appends.length, 1, 'answer was applied under one exact reception operation');
    assert.equal(state.memories.items.length, 1);
    assert.equal(state.memories.applies.length, 1, 'memory batch was applied once under its exact invocation');
    assert.deepEqual(state.view.members, [
      { source: 'messages', key: 0 },
      { source: 'messages', key: 1 },
      { source: 'memories', key: state.memories.items[0].id },
    ]);
    assert.deepEqual(requests(path), ['answer', 'memory']);
    assert.deepEqual(
      resumed.report.roots.map((head) => head.status),
      ['succeeded'],
    );
    const terminal = run('resume', path);
    assert.equal(terminal.status, 1);
    assert.equal(terminal.report.error.code, 'CHECKPOINT_CONTENT_CHANGED');
    assert.deepEqual(requests(path), ['answer', 'memory']);
  });
}

test('missing external feedback stays unavailable after restart and never resends', (t) => {
  const path = database(t);
  assert.equal(run('crash', path, 'missing-feedback').status, 73);
  const resumed = run('resume', path);
  assert.equal(resumed.status, 1, JSON.stringify(resumed.report));
  assert.equal(resumed.report.error.code, 'CHECKPOINT_CONTENT_CHANGED');
  assert.deepEqual(requests(path), ['answer']);
  assert.equal(resumed.report.state.transcript.messages.length, 1);
});

test('missing memory feedback remains an unavailable continuation rather than skipped extraction', (t) => {
  const path = database(t);
  assert.equal(run('crash', path, 'missing-memory-feedback').status, 73);
  const resumed = run('resume', path);
  assert.equal(resumed.status, 1, JSON.stringify(resumed.report));
  assert.equal(resumed.report.error.code, 'CHECKPOINT_CONTENT_CHANGED');
  assert.deepEqual(requests(path), ['answer', 'memory']);
  assert.equal(resumed.report.state.transcript.messages.length, 2);
  assert.equal(resumed.report.state.memories.items.length, 0);
});

for (const mode of ['new-input', 'changed-config', 'changed-budget']) {
  test(`restart admission refuses ${mode} before invoking any model or applying an old effect`, (t) => {
    const path = database(t);
    assert.equal(run('crash', path, 'feedback').status, 73);
    const resumed = run(mode, path);
    assert.equal(resumed.status, 1, JSON.stringify(resumed.report));
    assert.equal(resumed.report.error.code, 'CHECKPOINT_CONTENT_CHANGED');
    assert.deepEqual(requests(path), ['answer']);
    assert.equal(resumed.report.state.transcript.messages.filter((message) => message.role === 'assistant').length, 0);
  });
}

test('Scene recovery codec rejects a changed budget before a model request exists even without host admission', (t) => {
  const path = database(t);
  assert.equal(run('crash', path, 'materials').status, 73);
  const resumed = run('changed-budget-direct', path);
  assert.equal(resumed.status, 1, JSON.stringify(resumed.report));
  assert.equal(resumed.report.state.transcript.messages.length, 1);
  assert.equal(resumed.report.state.memories.items.length, 0);
  assert.throws(() => requests(path), { code: 'ENOENT' }, 'no model request was sent before or after the interruption');
});

for (const boundary of ['feedback', 'memory']) {
  test(`a later conversation restores ${boundary} with previous receipts and updates the existing memory identity`, (t) => {
    const path = database(t);
    const stopped = run('crash-history', path, boundary);
    assert.equal(stopped.status, 73, JSON.stringify(stopped.report));
    const previous = stopped.report.state.memories.items[0];
    assert.ok(previous);
    assert.equal(stopped.report.state.memories.sequence, boundary === 'memory' ? 2 : 1);
    const resumed = run('resume', path);
    assert.equal(resumed.status, 0, JSON.stringify(resumed.report));
    const state = resumed.report.state;
    assert.equal(state.transcript.messages.length, 4);
    assert.equal(state.transcript.appends.length, 2);
    assert.equal(state.memories.items.length, 1);
    assert.equal(state.memories.items[0].id, previous.id);
    assert.equal(state.memories.items[0].content, '再次确认偏好简短的中文回答。');
    assert.deepEqual(state.memories.items[0].sourceIndexes, [2]);
    assert.equal(state.memories.sequence, 2);
    assert.equal(state.memories.applies.length, 2);
    assert.equal(state.view.members.filter((member) => member.source === 'memories').length, 1);
    assert.deepEqual(requests(path), ['answer', 'memory', 'answer', 'memory']);
    assert.deepEqual(
      resumed.report.roots.map((head) => head.status),
      ['succeeded', 'succeeded'],
    );
  });
}

for (const boundary of ['invalid-memory-json', 'invalid-memory-length']) {
  test(`saved ${boundary} is still a business rejection handled by optional maintenance`, (t) => {
    const path = database(t);
    const stopped = run('crash', path, boundary);
    assert.equal(stopped.status, 73, JSON.stringify(stopped.report));
    const resumed = run('resume', path);
    assert.equal(resumed.status, 0, JSON.stringify(resumed.report));
    assert.equal(resumed.report.result, '好的，后续我会使用简短的中文回答。');
    assert.equal(resumed.report.state.transcript.messages.length, 2);
    assert.equal(resumed.report.state.memories.items.length, 0);
    assert.equal(resumed.report.handledProposals, 1);
    assert.deepEqual(requests(path), ['answer', 'memory']);
  });
}

for (const boundary of ['handled-memory-failure', 'handled-memory-failure-completed']) {
  test(`saved ${boundary} keeps the handled outcome without requiring a nonexistent response`, (t) => {
    const path = database(t);
    const stopped = run('crash', path, boundary);
    assert.equal(stopped.status, 73, JSON.stringify(stopped.report));
    const resumed = run('resume', path);
    assert.equal(resumed.status, 0, JSON.stringify(resumed.report));
    assert.equal(resumed.report.result, '好的，后续我会使用简短的中文回答。');
    assert.equal(resumed.report.state.transcript.messages.length, 2);
    assert.equal(resumed.report.state.memories.items.length, 0);
    assert.equal(resumed.report.handledProposals, 1);
    assert.deepEqual(requests(path), ['answer', 'memory']);
  });
}
