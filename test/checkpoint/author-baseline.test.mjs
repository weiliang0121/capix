import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Synthetic heads captured by the existing fixtures at commit 549f936, before
// factory values became concrete Scene/Group/Node objects. Never regenerate
// these during the test: it must check the stored format against new code.
function restore(fixture, sample) {
  const result = spawnSync(process.execPath, [new URL(`./fixtures/${fixture}.mjs`, import.meta.url).pathname, 'restore'], {
    input: readFileSync(new URL(`./fixtures/author-baseline/${sample}.json`, import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('concrete author objects restore pre-migration v4 positions and reference sets without rerunning children', () => {
  assert.deepEqual(restore('v4-author', 'relations'), {
    state: { expected: 'first', count: 2 },
    output: 'first',
    all: ['second', 'first'],
    plain: 'plain',
    children: 4,
    same: true,
  });
});

test('concrete author objects restore pre-migration typed reception values without rerunning acceptance', () => {
  const result = restore('reception', 'reception');
  assert.equal(result.value, '2026-01-01T00:00:00.000Z');
  assert.equal(result.empty, 'accepted');
  assert.notEqual(result.pid, process.pid);
});
