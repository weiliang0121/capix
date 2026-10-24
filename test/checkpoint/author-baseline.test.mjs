import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Synthetic heads captured by the existing fixtures at commit 549f936, before
// factory values became concrete Scene/Group/Node objects. Keep the historical
// version intact: v5 deliberately rejects these rather than silently relabeling them.
function restore(fixture, sample) {
  const result = spawnSync(process.execPath, [new URL(`./fixtures/${fixture}.mjs`, import.meta.url).pathname, 'restore'], {
    input: readFileSync(new URL(`./fixtures/author-baseline/${sample}.json`, import.meta.url)),
    encoding: 'utf8',
  });
  return result;
}

test('historical v4 relation baselines are rejected rather than silently upgraded', () => {
  const result = restore('v5-author', 'relations');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /formatVersion 5/);
});

test('historical v4 typed receptions are rejected without running reception callbacks', () => {
  const result = restore('reception', 'reception');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /formatVersion 5/);
});
