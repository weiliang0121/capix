import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('incremental selections retain occurrence identities across process exit and continue across points without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-selection-process-'));
  const worker = fileURLToPath(new URL('./fixtures/selection-process.mjs', import.meta.url));
  const commitsPath = join(directory, 'commits');
  const effectsPath = join(directory, 'effects');
  const run = (mode) => spawnSync(process.execPath, [worker, mode, commitsPath, effectsPath], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 30000 });
  try {
    const seed = run('seed');
    assert.equal(seed.status, 84, seed.error?.message ?? seed.stderr);
    const captured = JSON.parse(seed.stdout);
    assert.equal(captured.revision, 2);
    assert.equal(captured.delivery, undefined);
    assert.equal(captured.selection.revision, 2);
    assert.equal(captured.selection.nextOrder, 3);
    assert.deepEqual(
      captured.selection.occurrences.map((item) => item.order),
      [1, 2],
    );
    const firstChange = captured.writes[0].changes[0];
    const secondChange = captured.writes[1].changes[0];
    assert.equal(firstChange.append.length, 2);
    assert.deepEqual(firstChange.append[0].reference, firstChange.append[1].reference, 'equal child refs still have separate occurrences');
    assert.notEqual(firstChange.append[0].id, firstChange.append[1].id);
    assert.equal(secondChange.remove[0].id, firstChange.append[0].id);
    assert.equal(captured.selection.occurrences[0].id, firstChange.append[1].id);
    assert.equal(captured.selection.occurrences[1].id, secondChange.append[0].id);
    assert.equal(await readFile(effectsPath, 'utf8'), 'a\nb\n');

    const resumed = run('resume');
    assert.equal(resumed.status, 0, resumed.error?.message ?? resumed.stderr);
    const result = JSON.parse(resumed.stdout);
    assert.notEqual(result.pid, captured.pid);
    assert.equal(result.contextId, captured.contextId);
    assert.deepEqual(result.recoveredSelection, captured.selection, 'new MemoryStore reconstruction preserves the exact serialized selection basis');
    assert.equal(result.result, 2);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.revision, 5);
    assert.deepEqual(result.orders, [1, 2]);
    assert.equal(result.relationCount, 3, 'selection removal never removes established child facts');
    assert.deepEqual(result.outputs, ['a', 'b', 'c']);
    assert.equal(result.writes.length, 2);
    const [changed, unchanged] = result.writes;
    assert.equal(changed.point, 'first');
    assert.equal(changed.expectedRevision, 2);
    assert.equal(changed.changes.length, 1);
    const change = changed.changes[0];
    assert.equal(change.id, captured.selection.id);
    assert.equal(change.expectedRevision, captured.selection.revision);
    assert.equal(change.append.length, 1, 'cold continuation publishes only its new occurrence');
    assert.deepEqual(change.remove, [captured.selection.occurrences[0]], 'removal names the original occurrence id, order and reference');
    assert.equal(changed.children.length, 1, 'old relations are not republished after cold reconstruction');
    assert.equal(change.append[0].reference.contextId, changed.children[0].identity.contextId);
    assert.equal(unchanged.point, 'second');
    assert.equal(unchanged.expectedRevision, 3);
    assert.deepEqual(unchanged.changes, [], 'a compatible point switch does not republish the selection');
    assert.deepEqual(unchanged.children, []);
    assert.equal(result.selection.id, captured.selection.id);
    assert.equal(result.selection.revision, 3);
    assert.equal(result.selection.nextOrder, 4, 'retired occurrence orders remain reserved');
    assert.deepEqual(
      result.selection.occurrences.map((item) => item.order),
      [2, 3],
    );
    assert.deepEqual(result.selection.occurrences[0], captured.selection.occurrences[1]);
    assert.equal(result.selection.occurrences[1].id, change.append[0].id);
    assert.notEqual(change.append[0].id, firstChange.append[0].id, 'an occurrence retired before process exit is not reused');
    assert.notEqual(change.append[0].id, captured.selection.occurrences[0].id);
    assert.equal(await readFile(effectsPath, 'utf8'), 'a\nb\nc\n', 'neither the old root nor completed children replay their effects');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
