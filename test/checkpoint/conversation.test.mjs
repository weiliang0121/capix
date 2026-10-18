import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./conversation.fixture.mjs', import.meta.url));
function invoke(path, mode, boundary) {
  return spawnSync(process.execPath, [fixture, path, mode, boundary], { encoding: 'utf8', timeout: 15000 });
}
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-real-conversation-checkpoint-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'observer.sqlite');
}
for (const boundary of ['feedback', 'delivery', 'entity', 'accepted', 'executionDelivery']) {
  test(`real new conversation resumes after ${boundary} without repeating input, generation or answer append`, (t) => {
    const path = setup(t);
    const original = invoke(path, 'start', boundary);
    assert.equal(original.status, 74, original.stdout + original.stderr);
    const restored = invoke(path, 'restore', boundary);
    assert.equal(restored.status, 0, restored.stderr);
    const value = JSON.parse(restored.stdout);
    assert.equal(value.error, undefined, JSON.stringify(value.error));
    assert.deepEqual(value.result, { kind: 'answer', content: '真实对话恢复的回答。' });
    assert.deepEqual(
      value.calls.map((call) => call.purpose),
      ['answer', 'memory'],
    );
    assert.ok(value.calls.every((call) => call.model === 'fixed-model'));
    assert.deepEqual(
      value.transcript.messages.map((message) => message.role),
      ['user', 'assistant'],
    );
    assert.equal(value.transcript.appends.length, 1);
    assert.equal(value.transcript.appends[0].request.operation.parentContextId, value.run.executionContextId);
    assert.equal(value.root.delivery.status, 'succeeded');
    assert.equal(value.execution.delivery.status, 'succeeded');
    if (boundary === 'executionDelivery') assert.equal(value.memories.sequence, 1, 'R consumes the final E delivery without redoing its committed memory work');
    const again = JSON.parse(invoke(path, 'restore', boundary).stdout);
    assert.ok(again.error);
    assert.deepEqual(again.calls, value.calls);
    assert.deepEqual(again.transcript, value.transcript);
  });
}
for (const boundary of ['memory', 'pending']) {
  test(`real conversation refuses unsupported ${boundary} window without issuing another model call`, (t) => {
    const path = setup(t);
    assert.equal(invoke(path, 'start', boundary).status, 74);
    const restored = invoke(path, 'restore', boundary);
    assert.equal(restored.status, 0, restored.stderr);
    const value = JSON.parse(restored.stdout);
    assert.ok(value.error);
    assert.deepEqual(
      value.calls.map((call) => call.purpose),
      boundary === 'memory' ? ['answer', 'memory'] : ['answer'],
    );
    assert.equal(value.transcript.messages.length, boundary === 'memory' ? 2 : 1);
  });
}
test('subsequent conversation input prevents older checkpoint continuation', (t) => {
  const path = setup(t);
  assert.equal(invoke(path, 'start', 'feedback').status, 74);
  const restored = invoke(path, 'changed', 'feedback');
  assert.equal(restored.status, 0, restored.stderr);
  const value = JSON.parse(restored.stdout);
  assert.equal(value.error.code, 'CHECKPOINT_CONTENT_CHANGED');
  assert.deepEqual(
    value.calls.map((call) => call.purpose),
    ['answer'],
  );
  assert.equal(value.transcript.messages.length, 2);
});
