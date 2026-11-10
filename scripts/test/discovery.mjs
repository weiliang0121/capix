import { access, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

export async function testFiles(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`Test symlinks are not supported: ${join(path, entry.name)}`);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '.test-dist', 'fixtures', 'benchmarks'].includes(entry.name)) await visit(join(path, entry.name));
      } else if (entry.name.endsWith('.test.mjs')) files.push(join(path, entry.name));
    }
  }
  await visit(directory);
  if (!files.length) throw new Error(`No test entrypoints: ${directory}`);
  return files;
}

export async function workspacePackages(repository = root) {
  const packages = [];
  for (const entry of (await readdir(join(repository, 'packages'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(repository, 'packages', entry.name);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (!manifest.name || !manifest.scripts?.build || !manifest.scripts?.test) throw new Error(`Package must declare a name, build and test: ${directory}`);
    packages.push({ directory, manifest });
  }
  if (!packages.length) throw new Error('No workspace packages');
  if (new Set(packages.map(({ manifest }) => manifest.name)).size !== packages.length) throw new Error('Duplicate workspace package name');
  return packages;
}

export async function discover(mode, packageDirectory, repository = root) {
  if (mode === 'repository') return [{ name: 'repository', files: await testFiles(join(repository, 'testing/repository')) }];
  const packages = await workspacePackages(repository);
  const selected = mode === 'package' ? packages.filter(({ directory }) => directory === resolve(packageDirectory)) : packages;
  if (!selected.length) throw new Error(`Unknown package: ${packageDirectory}`);
  const groups = [];
  for (const entry of selected) groups.push({ name: entry.manifest.name, directory: entry.directory, manifest: entry.manifest, files: await testFiles(join(entry.directory, 'test')) });
  return groups;
}

export async function requireBuild(groups) {
  for (const { directory, manifest } of groups) {
    if (!manifest) continue;
    for (const target of Object.values(manifest.exports ?? {})) {
      for (const file of [target.import, target.types].filter(Boolean)) {
        try {
          await access(join(directory, file));
        } catch {
          throw new Error(`Missing build for ${manifest.name}: ${file}; run pnpm build or the package test command`);
        }
      }
    }
  }
}
