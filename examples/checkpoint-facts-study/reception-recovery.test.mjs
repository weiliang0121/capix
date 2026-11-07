import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const fixture = new URL('./reception-process.mjs', import.meta.url);
function execute(mode, path, cut, scenario) {
  const child = spawnSync(process.execPath, [fixture.pathname, mode, path, cut, scenario], { encoding: 'utf8' });
  assert.equal(child.signal, null, child.stderr);
  assert.ok(child.stdout.trim(), child.stderr);
  return { exit: child.status, value: JSON.parse(child.stdout) };
}

for (const cut of ['before-save', 'before-head', 'committed'])
  test(`reception evidence hard-exit recovery: ${cut}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-reception-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'study.sqlite');
    const first = execute('run', path, cut, 'accepted');
    assert.equal(first.exit, 73);
    const restored = execute('resume', path, cut, 'accepted');
    assert.equal(restored.exit, 0);
    assert.equal(restored.value.status, 'completed', restored.value.error);
    assert.deepEqual(restored.value.value, { step: 1, text: 'accepted material', score: 70 });
    assert.equal(restored.value.mappings, cut === 'committed' ? 0 : 1);
    assert.equal(restored.value.evidence.restoredCheck, cut === 'committed' ? 1 : 0);
    assert.equal(restored.value.evidence.persistenceCheck, cut === 'committed' ? 0 : 1);
    assert.equal(restored.value.evidence.establishmentCheck, cut === 'committed' ? 0 : 1);
  });

test('handled reception is rechecked from durable material without re-running the failed receiver', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'capix-reception-handled-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'study.sqlite');
  assert.equal(execute('run', path, 'committed', 'handled').exit, 73);
  const restored = execute('resume', path, 'committed', 'handled');
  assert.equal(restored.value.status, 'completed', restored.value.error);
  assert.equal(restored.value.mappings, 0);
  assert.equal(restored.value.evidence.restoredCheck, 1);
  assert.equal(restored.value.evidence.persistenceCheck, 0);
});

for (const scenario of ['changed-contract', 'invalid-decoder', 'impure'])
  test(`cold reception rejects ${scenario}; hot evidence is not imported`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-reception-reject-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'study.sqlite');
    const first = execute('run', path, 'committed', scenario);
    assert.equal(first.exit, 73);
    assert.equal(first.value.evidence.persistenceCheck, 1);
    const restored = execute('resume', path, 'committed', scenario);
    assert.equal(restored.exit, 0);
    assert.equal(restored.value.status, 'rejected');
    assert.equal(restored.value.mappings, 0);
    assert.equal(restored.value.head, scenario === 'impure' ? 'later-point' : 'accepted');
  });

for (const [name, sql] of [
  ['changed body', "UPDATE facts SET body = body || ' ' WHERE kind = 'accepted'"],
  ['missing body', "DELETE FROM facts WHERE kind = 'accepted'"],
  ['foreign owner', "UPDATE facts SET owner = 'foreign' WHERE kind = 'accepted'"],
])
  test(`cold reception rejects ${name} before exposing the recovered call`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-reception-corrupt-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'study.sqlite');
    assert.equal(execute('run', path, 'committed', 'accepted').exit, 73);
    const database = new DatabaseSync(path);
    assert.equal(Number(database.prepare(sql).run().changes), 1);
    database.close();
    const restored = execute('resume', path, 'committed', 'accepted');
    assert.equal(restored.exit, 0);
    assert.equal(restored.value.status, 'rejected');
    assert.equal(restored.value.mappings, 0);
    assert.equal(restored.value.head, 'accepted');
  });
