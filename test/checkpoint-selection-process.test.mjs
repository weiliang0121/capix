import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { measureDatabase } from '../examples/long-conversation/measurement.mjs';

test('incremental selections survive a real process exit and continue across points without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-selection-process-'));
  const worker = fileURLToPath(new URL('./fixtures/checkpoint-selection-process.mjs', import.meta.url));
  const args = [join(directory, 'store.sqlite'), join(directory, 'root'), join(directory, 'effects')];
  try {
    const seed = spawnSync(process.execPath, [worker, 'seed', ...args], { encoding: 'utf8', timeout: 30000 });
    assert.equal(seed.status, 84, seed.stderr);
    const resumed = spawnSync(process.execPath, [worker, 'resume', ...args], { encoding: 'utf8', timeout: 30000 });
    assert.equal(resumed.status, 0, resumed.stderr);
    const result = JSON.parse(resumed.stdout.trim());
    assert.equal(result.result, 2);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.orders, [1, 2]);
    assert.equal(result.relationCount, 3, 'removing selections never removes established child facts');
    assert.equal(result.writes.length, 2);
    assert.equal(result.writes[0].changes.length, 1);
    assert.equal(result.writes[0].changes[0].append.length, 1, 'cold continuation publishes only the new occurrence');
    assert.equal(result.writes[0].changes[0].remove.length, 1);
    assert.deepEqual(result.writes[1].changes, [], 'a compatible point switch does not republish the selection');
    assert.equal(await readFile(args[2], 'utf8'), 'a\nb\nc\n');
    const measured = measureDatabase(args[0]);
    assert.equal(measured.schemaVersion, 8);
    assert.equal(measured.checkpoints.facts.selections.count, 1);
    assert.equal(measured.checkpoints.facts.occurrences.count, 4, 'measurement retains identity tombstones in the count');
    assert.ok(measured.checkpoints.facts.selections.bytes > 0);
    assert.ok(measured.checkpoints.facts.occurrences.bytes > 0);
    const database = new DatabaseSync(args[0], { readOnly: true });
    try {
      const usage = database.prepare('SELECT checkpoint_bytes, interactions_bytes, exchanges_bytes FROM archive_usage').get();
      assert.equal(measured.archiveJsonBytes, usage.checkpoint_bytes + usage.interactions_bytes + usage.exchanges_bytes);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
