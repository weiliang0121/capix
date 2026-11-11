import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, json, registry, root } from '../release/packages.mjs';
import { pack } from './pack.mjs';

/** Verify the unminified 20-package candidate independently of public release artifacts. */
export async function check() {
  let temporary;
  let candidateLock;
  let stage = 'packing the candidate batch';
  try {
    const archives = await pack();
    const output = join(root, '.capix/integration');
    const lock = join(root, '.capix/integration.lock');
    await mkdir(lock);
    candidateLock = lock;
    const manifest = await json(join(output, 'manifest.json'));
    assert.deepEqual(manifest.packages, archives, 'Integration manifest does not match the packed batch');
    assert.equal(archives.length, 20);
    assert.equal(archives.filter((entry) => entry.private).length, 2);
    stage = 'preparing an external consumer';
    temporary = await mkdtemp(join(tmpdir(), 'capix-integration-'));
    const location = relative(root, temporary);
    assert.ok(location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location), 'Integration consumer must be outside the workspace');
    // Copy and authenticate the exact candidate bytes before npm can consume them.
    // A later pack cannot silently replace archives during this verification.
    const artifacts = join(temporary, 'artifacts');
    await mkdir(artifacts);
    for (const entry of archives) {
      const bytes = await readFile(join(output, entry.file));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.name}: tarball changed after packing`);
      await writeFile(join(artifacts, entry.file), bytes);
    }
    const consumer = join(temporary, 'consumer');
    await mkdir(consumer);
    const workspace = await json(join(root, 'package.json'));
    const dependencies = Object.fromEntries(archives.map((entry) => [entry.name, `file:${join(artifacts, entry.file)}`]));
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'capix-integration-consumer', private: true, type: 'module', dependencies, devDependencies: { zod: workspace.devDependencies.zod, typescript: workspace.devDependencies.typescript, '@types/node': workspace.devDependencies['@types/node'] } }, null, 2) + '\n');
    stage = 'installing all 20 candidate tarballs';
    command('npm', ['install', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund', '--prefer-online', `--registry=${registry}`, '--fetch-timeout=20000', '--fetch-retries=1'], { cwd: consumer });
    command('npm', ['ls', '--all'], { cwd: consumer, stdio: 'pipe' });
    stage = 'checking installed exports';
    for (const entry of archives) {
      const installed = await json(join(consumer, 'node_modules', entry.name, 'package.json'));
      assert.equal(installed.name, entry.name);
      assert.equal(installed.version, entry.version);
      assert.deepEqual(Object.keys(installed.exports), entry.exports, `${entry.name}: installed exports differ from the candidate`);
    }
    const imports = archives.flatMap((entry) => entry.exports.map((name) => entry.name + (name === '.' ? '' : name.slice(1))));
    await writeFile(
      join(consumer, 'exports.mjs'),
      `import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
const installedRoot = resolve('node_modules') + sep;
for (const name of ${JSON.stringify(imports)}) {
  assert.ok(fileURLToPath(import.meta.resolve(name)).startsWith(installedRoot), name + ': export escaped the isolated installation');
  await import(name);
}
console.log('Loaded ${imports.length} exports from 20 installed candidate tarballs');
`,
    );
    command(process.execPath, ['exports.mjs'], { cwd: consumer });
    for (const fixture of ['consumer.mjs', 'consumer.ts']) {
      await cp(join(root, 'scripts/release/fixtures', fixture), join(consumer, fixture));
      await cp(join(root, 'scripts/integration/fixtures', fixture), join(consumer, `private-${fixture}`));
    }
    stage = 'running public and private API consumers';
    command(process.execPath, ['consumer.mjs'], { cwd: consumer });
    command(process.execPath, ['private-consumer.mjs'], { cwd: consumer });
    stage = 'compiling public and private declaration consumers';
    command(process.execPath, ['node_modules/typescript/bin/tsc', '--ignoreConfig', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2023,DOM,DOM.Iterable', '--skipLibCheck', 'false', 'consumer.ts', 'private-consumer.ts'], { cwd: consumer });
    // Record only the candidate batch tested above, never the compressed release batch.
    await writeFile(join(output, 'verified.json'), JSON.stringify({ schemaVersion: 1, baselineHead: manifest.baselineHead, dirty: manifest.dirty, sourceSha256: manifest.source.sha256, packages: archives }, null, 2) + '\n');
    console.log(`Verified ${archives.length} integration tarballs in an external consumer: ${relative(root, output)}`);
    return archives;
  } catch (cause) {
    throw new Error(`Integration distribution check failed while ${stage}`, { cause });
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } finally {
      if (candidateLock) await rm(candidateLock, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await check();
