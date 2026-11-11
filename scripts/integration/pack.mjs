import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, files, isDistributionFile, json, packages, root } from '../release/packages.mjs';

const privateDirectories = ['packages/client-http', 'packages/client-runtime', 'packages/observer-content'];
const output = join(root, '.capix/integration');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function sourceSnapshot(entries) {
  const paths = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json', 'scripts/release/packages.mjs'];
  async function visit(directory) {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'dist', '.test-dist', '.DS_Store'].includes(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;
      assert.ok(!entry.isSymbolicLink(), `Source symlink is not supported: ${directory}/${entry.name}`);
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else paths.push(path);
    }
  }
  for (const entry of entries) await visit(entry.directory);
  await visit('scripts/integration');
  await visit('scripts/release/fixtures');
  const sources = await Promise.all(paths.sort().map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })));
  return { sha256: sha256(JSON.stringify(sources)), files: sources };
}

export async function pack() {
  const publicEntries = await packages();
  const privateEntries = await Promise.all(privateDirectories.map(async (directory) => ({ directory, path: join(root, directory), manifest: await json(join(root, directory, 'package.json')) })));
  for (const entry of privateEntries) assert.equal(entry.manifest.private, true);
  const entries = [...publicEntries, ...privateEntries];
  assert.equal(entries.length, 21);
  assert.equal(new Set(entries.map((entry) => entry.manifest.name)).size, 21);
  await mkdir(join(root, '.capix'), { recursive: true });
  const lock = join(root, '.capix/integration.lock');
  await mkdir(lock);
  let staging;
  let backup;
  try {
    staging = await mkdtemp(join(root, '.capix/integration-pending-'));
    const source = await sourceSnapshot(entries);
    const baselineHead = command('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    const dirty = command('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', stdio: 'pipe' }).trim().length > 0;
    for (const entry of entries) await rm(join(entry.path, 'dist'), { recursive: true, force: true });
    command('pnpm', [...entries.flatMap((entry) => ['--filter', entry.manifest.name]), '-r', '--sort', 'exec', 'tsc', '-p', 'tsconfig.json', '--sourceMap', 'false', '--declarationMap', 'false']);
    const archives = [];
    for (const entry of entries) {
      const file = `${entry.manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${entry.manifest.version}.tgz`;
      const archive = join(staging, file);
      command('pnpm', ['pack', '--out', archive, '--json'], { cwd: entry.path, stdio: 'pipe' });
      const listing = command('tar', ['-tzf', archive], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n');
      assert.ok(
        listing.every((name) => name.startsWith('package/') && !name.includes('..') && !name.includes('\\')),
        `${file}: unsafe archive path`,
      );
      const extraction = join(staging, 'verify');
      await mkdir(extraction);
      command('tar', ['-xzf', archive, '-C', extraction], { stdio: 'pipe' });
      const directory = join(extraction, 'package');
      const packed = await json(join(directory, 'package.json'));
      assert.equal(packed.name, entry.manifest.name);
      assert.equal(packed.version, entry.manifest.version);
      assert.equal(packed.private, entry.manifest.private);
      const present = new Set();
      for (const path of await files(directory)) {
        const name = relative(directory, path).split('\\').join('/');
        present.add(name);
        assert.ok(isDistributionFile(name), `${file}: unexpected file ${name}`);
      }
      for (const target of Object.values(packed.exports)) {
        for (const kind of ['import', 'types']) assert.ok(present.has(target[kind]?.replace(/^\.\//, '')), `${file}: missing ${kind} export`);
      }
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, version] of Object.entries(packed[field] ?? {})) {
          assert.ok(!/^(?:workspace|link|file):/.test(version), `${file}: unresolved dependency ${name}`);
          const internal = entries.find((item) => item.manifest.name === name);
          if (internal) assert.equal(version, internal.manifest.version, `${file}: wrong batch dependency ${name}`);
        }
      }
      archives.push({ name: packed.name, version: packed.version, private: packed.private, file, sha256: sha256(await readFile(archive)), exports: Object.keys(packed.exports) });
      await rm(extraction, { recursive: true });
    }
    assert.equal((await sourceSnapshot(entries)).sha256, source.sha256, 'Sources changed during packing; retry with a stable working tree');
    assert.equal(command('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(), baselineHead, 'HEAD changed during packing');
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({ schemaVersion: 1, baselineHead, dirty, source, packages: archives }, null, 2) + '\n');
    try {
      backup = await mkdtemp(join(root, '.capix/integration-previous-'));
      await rm(backup, { recursive: true });
      await rename(output, backup);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      backup = undefined;
    }
    try {
      await rename(staging, output);
      staging = undefined;
    } catch (error) {
      if (backup) await rename(backup, output);
      backup = undefined;
      throw error;
    }
    if (backup) await rm(backup, { recursive: true });
    console.log(`Prepared ${archives.length} integration tarballs: ${relative(root, output)} (HEAD ${baselineHead}, dirty=${dirty}, source ${source.sha256})`);
    return archives;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await pack();
