import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { spawnSync } from 'node:child_process';

import { test } from 'node:test';

// Synthetic heads captured by the existing fixtures at commit 549f936, before
// factory values became concrete Scene/Group/Node objects. Keep the historical
// version intact: the current format deliberately rejects these rather than silently relabeling them.
function restore(fixture, sample) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`./fixtures/${fixture}.mjs`, import.meta.url)), 'restore'], {
    input: readFileSync(new URL(`./fixtures/author-baseline/${sample}.json`, import.meta.url)),
    encoding: 'utf8',
  });
  return result;
}

test('historical v4 relation baselines are rejected rather than silently upgraded', () => {
  const result = restore('author', 'relations');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /formatVersion 6/);
});

test('historical v4 typed receptions are rejected without running reception callbacks', () => {
  const result = restore('reception', 'reception');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /formatVersion 6/);
});
