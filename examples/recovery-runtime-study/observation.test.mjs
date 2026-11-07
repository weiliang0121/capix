import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-recovery-observation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'probe.sqlite');
}
function invoke(mode, path, policy = 'business') {
  const process = spawnSync(globalThis.process.execPath, [new URL('./observation-process.mjs', import.meta.url).pathname, mode, path, policy], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(process.status, mode === 'cut' ? 73 : 0, process.stderr);
  assert.equal(process.error, undefined);
  return JSON.parse(process.stdout.trim());
}

test('normal work.observation delivers once and strict failure survives a business catch', (t) => {
  const result = invoke('run', database(t));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'OBSERVATION_FAILED');
  assert.deepEqual(result.counts, { boundObservers: 1, body: 1, business: 1, businessReturned: 0, resourceBody: 0, resourceReturned: 0, caught: 1 });
  assert.equal(result.head.delivery.status, 'failed');
  assert.equal(result.events.filter((event) => event.source === 'passive-business').length, 1);
  assert.equal(result.running, false);
});

test('COUNTEREXAMPLE: resumed work.observation currently reaches neither strict nor passive observers', (t) => {
  const path = database(t);
  const cut = invoke('cut', path);
  assert.equal(cut.status, 'cut-after-save');
  assert.equal(cut.counts.body, 0);
  assert.equal(cut.head.delivery, null);
  const result = invoke('resume', path);
  assert.notEqual(result.pid, cut.pid);
  assert.equal(result.head.contextId, cut.head.contextId);
  assert.equal(result.status, 'succeeded'); // Characterizes the gap, not the desired contract.
  assert.equal(result.output, 'value');
  assert.deepEqual(result.counts, { boundObservers: 0, body: 1, business: 0, businessReturned: 1, resourceBody: 1, resourceReturned: 1, caught: 0 });
  assert.equal(JSON.stringify(result.events).includes('required-business'), false);
  assert.ok(result.events.some((event) => event.source === 'strict-checkpoint' && event.kind === 'resource' && event.detail === 'returned'));
  assert.ok(result.events.some((event) => event.source === 'passive-checkpoint' && event.kind === 'installed'));
  assert.equal(result.head.delivery.status, 'succeeded');
  assert.equal(result.running, false);
});

test('control: required resource observation still fails real resume and cannot be swallowed', (t) => {
  const path = database(t);
  invoke('cut', path, 'resource');
  const result = invoke('resume', path, 'resource');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'OBSERVATION_FAILED');
  assert.deepEqual(result.counts, { boundObservers: 0, body: 1, business: 0, businessReturned: 1, resourceBody: 1, resourceReturned: 0, caught: 1 });
  assert.equal(result.head.delivery.status, 'failed');
  assert.ok(result.events.some((event) => event.source === 'strict-checkpoint' && event.kind === 'resource' && event.detail === 'returned'));
  assert.ok(result.events.some((event) => event.source === 'passive-checkpoint' && event.kind === 'resource' && event.detail === 'returned'));
  assert.equal(result.running, false);
});
