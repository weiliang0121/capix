import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';

import { test } from 'node:test';

test('real factory declarations preserve scoped child identities, duplicate definitions and reference arrays across processes', () => {
  const worker = new URL('./fixtures/author.mjs', import.meta.url);
  const run = (mode, input, variant) => spawnSync(process.execPath, [fileURLToPath(worker), mode, ...(variant ? [variant] : [])], { input, encoding: 'utf8', cwd: fileURLToPath(new URL('../../', import.meta.url)) });
  const captured = run('capture');
  assert.equal(captured.status, 0, captured.stderr);
  const image = JSON.parse(captured.stdout).image;
  assert.deepEqual(
    image.frame.children.map((child) => child.target.position),
    [0, 0, 1, 2],
  );
  assert.equal(image.frame.children[3].contract, undefined);
  assert.equal(image.frame.children.length, 4, 'slots select a subset while the full relationship frame remains saved');
  assert.equal(image.references.chosen.contextId, image.references.repeated.contextId);
  const resumed = run('restore', captured.stdout);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout), { state: { expected: 'first', count: 2 }, output: 'first', all: ['second', 'first'], plain: 'plain', children: 4, same: true });
  for (const variant of ['version', 'swapped']) {
    const rejected = run('restore', captured.stdout, variant);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(rejected.stderr, /incompatible|different child declaration/);
  }
  for (const variant of ['forged-point', 'forged-reference', 'wrong-declaration', 'live-acceptance']) {
    const rejected = run('capture', undefined, variant);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(rejected.stderr, /registered|foreign|different child declaration|ordinary data/);
    assert.equal(rejected.stdout, '', 'rejected capture must not save a partial parent image');
  }
});
