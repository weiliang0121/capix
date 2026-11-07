import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { hash } from './fact-store.mjs';
import { StableValues } from './stable.mjs';

const fixture = new URL('./saved-facts-process.mjs', import.meta.url);
function execute(mode, path, scenario) {
  const result = spawnSync(process.execPath, [fixture.pathname, mode, path, scenario], { encoding: 'utf8' });
  assert.equal(result.signal, null, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr);
  return { exit: result.status, value: JSON.parse(result.stdout) };
}

for (const scenario of ['valid', 'handled'])
  test(`cold saved facts validate original ${scenario} combination before continuing`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-saved-facts-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'study.sqlite');
    assert.equal(execute('run', path, scenario).exit, 73);
    const restored = execute('resume', path, scenario);
    assert.equal(restored.exit, 0);
    assert.equal(restored.value.status, 'completed', restored.value.error);
    assert.equal(restored.value.continued, true);
    assert.equal(restored.value.authorChecks, 2, 'Original check precedes a second checked save');
    assert.equal(restored.value.reception.restoredCheck, 1);
    assert.equal(restored.value.reception.persistenceCheck, 0);
    assert.ok(restored.value.store.restoreFacts > 0, 'Cold restoration is still full');
    assert.equal(restored.value.revision, 2);
  });

for (const scenario of ['unread-target', 'unread-cardinality', 'unread-missing', 'unread-extra'])
  test(`cold declaration authentication rejects ${scenario} even if author reads no facts`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-saved-facts-unread-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'study.sqlite');
    assert.equal(execute('run', path, scenario).exit, 73);
    const restored = execute('resume', path, scenario);
    assert.equal(restored.exit, 0);
    assert.equal(restored.value.status, 'rejected');
    assert.equal(restored.value.continued, false);
    assert.equal(restored.value.authorChecks, 0, 'Reference authentication precedes the author callback');
    assert.equal(restored.value.revision, 1);
  });

for (const part of ['point', 'state', 'occurrence'])
  test(`cold restore rejects incompatible original ${part} before checking any new state`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-saved-facts-combination-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'study.sqlite');
    assert.equal(execute('run', path, 'valid').exit, 73);
    const database = new DatabaseSync(path);
    const head = JSON.parse(database.prepare("SELECT body FROM heads WHERE owner='parent'").get().body);
    if (part === 'point') head.point = 'unknown-point';
    else {
      const values = new StableValues();
      const envelope = values.decode(head.state);
      const state = { ...envelope.value, ...(part === 'state' ? { step: 999 } : { occurrence: 'not-the-saved-occurrence' }) };
      head.state = values.encode(values.own({ type: 'plain', value: state }));
    }
    const body = JSON.stringify(head);
    database.prepare("UPDATE heads SET body=?,digest=? WHERE owner='parent'").run(body, hash(body));
    database.close();
    const restored = execute('resume', path, 'valid');
    assert.equal(restored.exit, 0);
    assert.equal(restored.value.status, 'rejected');
    assert.equal(restored.value.continued, false);
    assert.equal(restored.value.authorChecks, 1, 'The original saved combination is checked');
    assert.equal(restored.value.revision, 1);
  });
