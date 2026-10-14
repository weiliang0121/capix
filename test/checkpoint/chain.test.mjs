import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const boundary of ['feedback', 'delivery', 'entity', 'accepted']) {
  test(`new process resumes R/E/O after ${boundary}, with one model call and one formal append`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'capix-checkpoint-chain-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.sqlite');
    const fixture = fileURLToPath(new URL('./chain.fixture.mjs', import.meta.url));
    const stopped = spawnSync(process.execPath, [fixture, path, 'start', boundary], { encoding: 'utf8', timeout: 15000 });
    assert.equal(stopped.status, 74, stopped.stderr);
    const recovered = spawnSync(process.execPath, [fixture, path, 'resume', boundary], { encoding: 'utf8', timeout: 15000 });
    assert.equal(recovered.status, 0, recovered.stderr);
    const result = JSON.parse(recovered.stdout);
    assert.equal(result.calls, 1);
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.messages[1], { role: 'assistant', content: 'fixed answer' });
    assert.equal(result.appends.length, 1);
    assert.equal(result.output.answer, 'fixed answer');
    assert.equal(result.output.receipt.start, 1);
    assert.equal(result.terminal.status, 'succeeded');
    assert.ok(result.recovery.length >= 2);
    assert.ok(result.restoredChildren.some((child) => child.mode === 'continuation'));
    if (boundary === 'delivery' || boundary === 'entity') assert.ok(result.restoredChildren.some((child) => child.mode === 'delivery' && child.state === 'returned'));
    assert.equal(new Set(result.recovery.map((item) => item.activityId)).size, result.recovery.length);
    const duplicate = spawnSync(process.execPath, [fixture, path, 'resume', boundary], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /terminal/);
  });
}
