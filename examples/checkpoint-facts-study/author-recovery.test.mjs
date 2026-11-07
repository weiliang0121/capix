import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const fixture = new URL('./author-process.mjs', import.meta.url);
const cases = [
  ['tools', 'waiting-no-child', 'rejected', 0, 0],
  ['tools', 'child-active', 'completed', 1, 1],
  ['tools', 'child-finished', 'completed', 1, 1],
  ['tools', 'accept-facts', 'completed', 1, 2],
  ['tools', 'accept-events', 'completed', 1, 2],
  ['tools', 'accept-head', 'completed', 1, 2],
  ['tools', 'accept-committed', 'completed', 1, 1],
  ['maintenance', 'saved', 'completed', 0, 0],
  ['capture', 'saved', 'completed', 0, 0],
];
for (const [scenario, cut, status, effect, mapping] of cases)
  test(`author contract fresh-process ${scenario}/${cut}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-author-cut-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'study.sqlite');
    const run = spawnSync(process.execPath, [fixture.pathname, 'run', path, scenario, cut], { encoding: 'utf8' });
    assert.equal(run.status, 73, run.stderr || run.stdout);
    const resume = spawnSync(process.execPath, [fixture.pathname, 'resume', path, scenario], { encoding: 'utf8' });
    assert.equal(resume.status, 0, resume.stderr);
    const result = JSON.parse(resume.stdout);
    assert.equal(result.status, status, JSON.stringify(result));
    const counts = Object.fromEntries(result.effects.map((row) => [row.kind, row.n]));
    assert.equal(counts.effect ?? 0, effect);
    assert.equal(counts.mapping ?? 0, mapping);
    if (scenario === 'capture') {
      assert.equal(result.text, 'old entity value');
      assert.equal(result.version, 7);
      assert.equal(counts['source-read'], 1);
    }
    if (status === 'completed') {
      const again = spawnSync(process.execPath, [fixture.pathname, 'resume', path, scenario], { encoding: 'utf8' });
      assert.equal(again.status, 0, again.stderr);
      const terminal = JSON.parse(again.stdout);
      assert.equal(terminal.status, 'terminal');
      assert.deepEqual(terminal.effects, result.effects);
    }
  });
