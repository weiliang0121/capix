import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover, requireBuild, testFiles, workspacePackages } from '../../scripts/test/discovery.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'capix-test-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pkg = join(directory, 'packages/example');
  await mkdir(join(pkg, 'test/types'), { recursive: true });
  const manifest = { name: '@example/package', scripts: { build: 'build', test: 'test' }, exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } } };
  await writeFile(join(pkg, 'package.json'), JSON.stringify(manifest));
  return { directory, pkg, manifest };
}

test('discovery requires actual entrypoints and discovers type probes without executing fixtures', async (t) => {
  const { directory, pkg } = await fixture(t);
  await assert.rejects(discover('packages', undefined, directory), /No test entrypoints/);
  await writeFile(join(pkg, 'test/types/public.test.mjs'), '');
  await mkdir(join(pkg, 'test/fixtures'));
  await writeFile(join(pkg, 'test/fixtures/worker.test.mjs'), '');
  await writeFile(join(pkg, 'test/types/negative.ts'), '');
  const groups = await discover('packages', undefined, directory);
  assert.deepEqual(
    groups.map(({ name, files }) => ({ name, files })),
    [{ name: '@example/package', files: [join(pkg, 'test/types/public.test.mjs')] }],
  );
  assert.deepEqual(await discover('package', pkg, directory), groups);
  await assert.rejects(discover('package', join(directory, 'absent'), directory), /Unknown package/);
  await assert.rejects(requireBuild(groups), /Missing build/);
  await mkdir(join(pkg, 'dist'));
  await writeFile(join(pkg, 'dist/index.js'), '');
  await writeFile(join(pkg, 'dist/index.d.ts'), '');
  await requireBuild(groups);
});

test('a missing package test script or a test symlink cannot silently skip coverage', async (t) => {
  const { directory, pkg, manifest } = await fixture(t);
  delete manifest.scripts.test;
  await writeFile(join(pkg, 'package.json'), JSON.stringify(manifest));
  await assert.rejects(workspacePackages(directory), /declare a name, build and test/);
  await symlink(join(pkg, 'package.json'), join(pkg, 'test/linked.test.mjs'));
  await assert.rejects(testFiles(join(pkg, 'test')), /symlinks/);
});

test('repository discovery has its own explicit nonempty scope', async (t) => {
  const { directory } = await fixture(t);
  await mkdir(join(directory, 'testing/repository'), { recursive: true });
  await assert.rejects(discover('repository', undefined, directory), /No test entrypoints/);
  await writeFile(join(directory, 'testing/repository/workspace.test.mjs'), '');
  assert.equal((await discover('repository', undefined, directory))[0].files.length, 1);
});
