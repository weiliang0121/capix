import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { hash } from './fact-store.mjs';
import { StableValues } from './stable.mjs';

const script = new URL('./point-layout-process.mjs', import.meta.url);
function run(mode, path, scenario) {
  const result = spawnSync(process.execPath, [script.pathname, mode, path, scenario], { encoding: 'utf8' });
  assert.equal(result.signal, null, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr);
  return { exit: result.status, value: JSON.parse(result.stdout) };
}
function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-point-layout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'study.sqlite');
}

for (const scenario of ['valid', 'preverify', 'inactive', 'empty-head']) {
  test(`fresh-process point layout qualification and explicit choices: ${scenario}`, (t) => {
    const path = database(t);
    const started = run('run', path, scenario);
    assert.equal(started.exit, 73, started.value.error);
    const result = run('resume', path, scenario);
    assert.equal(result.exit, 0);
    assert.equal(result.value.status, 'completed', result.value.error);
    assert.equal(result.value.continued, true);
    assert.equal(result.value.reception.restoredCheck, 2);
    assert.equal(result.value.reception.persistenceCheck, 0);
    assert.equal(result.value.revision, started.value.revision + 1);
    assert.equal(result.value.authorChecks, 2, 'Original saved point is checked before the next save');
    if (scenario === 'preverify') assert.equal(result.value.preverifyRejected, true);
    if (scenario === 'inactive' || scenario === 'empty-head') assert.equal(result.value.inactiveRejected, true);
  });
}

for (const scenario of ['point-version', 'source-map', 'alias-map', 'cardinality', 'target', 'counterfeit-head', 'decoder-reentry']) {
  test(`cold point layout rejects incompatible ${scenario} before a new point runs`, (t) => {
    const path = database(t);
    assert.equal(run('run', path, scenario).exit, 73);
    const result = run('resume', path, scenario);
    assert.equal(result.value.status, 'rejected');
    assert.equal(result.value.continued, false);
    assert.equal(result.value.authorChecks, 0);
    assert.equal(result.value.revision, 2);
  });
}

test('a second cold resume takes selection coverage from the latest head, not a union of prior points', (t) => {
  const path = database(t);
  assert.equal(run('run', path, 'inactive').exit, 73);
  const first = run('resume', path, 'inactive');
  assert.equal(first.value.status, 'completed', first.value.error);
  assert.equal(first.value.revision, 3);
  const second = run('resume', path, 'valid');
  assert.equal(second.value.status, 'rejected');
  assert.equal(second.value.continued, false);
  assert.equal(second.value.authorChecks, 1, 'Latest single point is checked, old many selection is not revived');
  assert.equal(second.value.revision, 3);
});

for (const part of ['state', 'layout', 'point']) {
  test(`cold qualification refuses altered original ${part} even with a recomputed storage digest`, (t) => {
    const path = database(t);
    assert.equal(run('run', path, 'valid').exit, 73);
    const db = new DatabaseSync(path);
    const head = JSON.parse(db.prepare("SELECT body FROM heads WHERE owner='parent'").get().body);
    const values = new StableValues();
    const decoded = values.decode(head.state);
    const envelope = structuredClone(decoded.value);
    if (part === 'state') envelope.state.expected = 99;
    if (part === 'layout') envelope.layout[0].source = 'spare-many';
    if (part === 'point') envelope.point.name = 'empty';
    head.state = values.encode(values.own({ type: 'plain', value: envelope }));
    const body = JSON.stringify(head);
    db.prepare("UPDATE heads SET body=?,digest=? WHERE owner='parent'").run(body, hash(body));
    db.close();
    const result = run('resume', path, 'valid');
    assert.equal(result.value.status, 'rejected');
    assert.equal(result.value.continued, false);
    assert.equal(result.value.revision, 2);
    assert.equal(result.value.authorChecks, part === 'state' ? 1 : 0);
  });
}
