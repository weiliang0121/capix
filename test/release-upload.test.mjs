import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { registry } from '../scripts/release/packages.mjs';
import { upload } from '../scripts/release/upload.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'release-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const releases = [];
  for (const name of ['contracts', 'protocol', 'runtime']) {
    const content = `verified ${name} package bytes`;
    const path = `${name}.tgz`;
    await writeFile(join(directory, path), content);
    releases.push({ kind: 'publish', name: `@example/${name}`, version: '0.1.0', access: 'public', tag: 'latest', tarball: { path, integrity: `sha256-${createHash('sha256').update(content).digest('base64')}` } });
  }
  return { directory, releases, plan: { version: 1, plan: [[releases[0]], [releases[1], releases[2]]] } };
}

test('upload preserves dependency order and publishes exact archives through an interactive npm terminal', async (t) => {
  const { directory, releases, plan } = await fixture(t);
  const calls = [];
  await upload(plan, directory, (...args) => calls.push(args));
  assert.deepEqual(
    calls,
    releases.map((release) => ['npm', ['publish', join(directory, release.tarball.path), '--access=public', '--tag=latest', `--registry=${registry}`, '--auth-type=web', '--ignore-scripts', '--provenance=false'], { stdio: 'inherit' }]),
  );
});

test('upload stops at the first command failure without retrying or publishing later packages', async (t) => {
  const { directory, plan } = await fixture(t);
  const failure = new Error('unknown publication outcome');
  let calls = 0;
  await assert.rejects(
    upload(plan, directory, () => {
      calls++;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test('upload verifies each archive again immediately before publishing it', async (t) => {
  const { directory, releases, plan } = await fixture(t);
  let calls = 0;
  await assert.rejects(
    upload(plan, directory, () => {
      calls++;
      writeFileSync(join(directory, releases[1].tarball.path), 'modified during the first publication');
    }),
  );
  assert.equal(calls, 1);
});

test('upload makes no commands for an empty remaining publication plan', async (t) => {
  const { directory } = await fixture(t);
  await upload({ version: 1, plan: [] }, directory, () => assert.fail('Empty plan must not publish'));
});

test('upload rejects unsafe artifact paths and publication policies before invoking npm', async (t) => {
  const { directory, releases } = await fixture(t);
  const release = releases[0];
  for (const invalid of [
    { ...release, tarball: { ...release.tarball, path: '../contracts.tgz' } },
    { ...release, tarball: { ...release.tarball, path: 'contracts' } },
    { ...release, access: 'restricted' },
    { ...release, tag: 'beta' },
  ]) {
    await assert.rejects(upload({ version: 1, plan: [[invalid]] }, directory, () => assert.fail('Invalid publication must not invoke npm')));
  }
});
