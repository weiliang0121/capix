import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const executable = new URL('./tool-prefix-process.mjs', import.meta.url);
const cuts = ['entity-closed', 'prefix-committed', 'cp-uncommitted', 'cp-committed', 'terminal-committed'];
function processRun(mode, path, cut = 'none') {
  return spawnSync(process.execPath, [executable.pathname, mode, path, cut], { encoding: 'utf8', timeout: 15_000 });
}
function database(path, work) {
  const db = new DatabaseSync(path);
  try {
    return work(db);
  } finally {
    db.close();
  }
}
function persisted(path) {
  const entity = database(`${path}.entity`, (db) => JSON.parse(db.prepare('SELECT body FROM entity WHERE id = 1').get().body));
  const prefixes = database(`${path}.prefix`, (db) =>
    db
      .prepare('SELECT id FROM tool_prefix_nodes ORDER BY ordinal')
      .all()
      .map((row) => row.id),
  );
  const head = database(path, (db) => JSON.parse(db.prepare('SELECT body FROM heads WHERE owner = ?').get('loop').body));
  return { entity, prefixes, head };
}
function fixture(t, cut) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-prefix-head-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'head.sqlite');
  const crashed = processRun('run', path, cut);
  assert.equal(crashed.status, 73, crashed.stderr || crashed.stdout);
  return path;
}

for (const cut of cuts) {
  test(`actual entity + durable prefix + experimental head survives hard exit: ${cut}`, (t) => {
    const path = fixture(t, cut);
    const before = persisted(path);
    assert.equal(before.entity.sequence, 2);
    assert.equal(before.entity.entries.length, 1);
    assert.equal(before.entity.entries[0].feedback.length, 1);
    assert.equal(before.prefixes.length, cut === 'entity-closed' ? 0 : 1);
    assert.equal(before.head.revision, ['entity-closed', 'prefix-committed', 'cp-uncommitted'].includes(cut) ? 1 : cut === 'cp-committed' ? 2 : 3);
    const resumed = processRun('resume', path);
    assert.equal(resumed.status, 0, resumed.stderr);
    const result = JSON.parse(resumed.stdout);
    assert.equal(result.status, cut === 'terminal-committed' ? 'terminal' : 'completed', JSON.stringify(result));
    assert.equal(result.entityWrites, 0, 'Feedback is confirmed; the entity is not written again');
    assert.equal(result.prefixWrites, cut === 'entity-closed' ? 1 : 0);
    assert.equal(result.headStatus, 'succeeded');
    const after = persisted(path);
    assert.deepEqual(after.entity, before.entity, 'No new exchange, revision, operation or tool ID is invented');
    assert.equal(after.prefixes.length, 1);
    if (before.prefixes.length) assert.deepEqual(after.prefixes, before.prefixes, 'Orphan prefix commit is confirmed under the original ID');
    const again = processRun('resume', path);
    assert.equal(again.status, 0, again.stderr);
    const terminal = JSON.parse(again.stdout);
    assert.equal(terminal.status, 'terminal');
    assert.equal(terminal.entityWrites, 0);
    assert.equal(terminal.prefixWrites, 0);
    assert.deepEqual(persisted(path), after, 'Terminal restoration cannot advance any store');
  });
}

for (const [name, mutate] of [
  ['missing prefix chain', (path) => database(`${path}.prefix`, (db) => db.exec('DELETE FROM tool_prefix_chains'))],
  ['missing prefix row', (path) => database(`${path}.prefix`, (db) => db.exec('DELETE FROM tool_prefix_nodes'))],
  ['damaged prefix body', (path) => database(`${path}.prefix`, (db) => db.exec("UPDATE tool_prefix_nodes SET body = '{}'"))],
  ['missing actual entity body', (path) => database(`${path}.entity`, (db) => db.exec('DELETE FROM entity'))],
  [
    'missing referenced exchange',
    (path) =>
      database(`${path}.entity`, (db) => {
        const state = JSON.parse(db.prepare('SELECT body FROM entity WHERE id = 1').get().body);
        state.entries = [];
        state.sequence = 0;
        db.prepare('UPDATE entity SET body = ? WHERE id = 1').run(JSON.stringify(state));
      }),
  ],
  ['missing checkpoint input fact', (path) => database(path, (db) => db.exec("DELETE FROM facts WHERE kind = 'input'"))],
]) {
  test(`cold compact head refuses ${name} without creating replacement facts`, (t) => {
    const path = fixture(t, 'cp-committed');
    mutate(path);
    const resumed = processRun('resume', path);
    assert.equal(resumed.status, 0, resumed.stderr);
    const result = JSON.parse(resumed.stdout);
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.equal(result.entityWrites, 0);
    assert.equal(result.prefixWrites ?? 0, 0);
  });
}
