import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from './build.mjs';
import { banner, command, files, json, registry, releaseDirectory, root } from './packages.mjs';

export async function check() {
  const entries = await build();
  await mkdir(releaseDirectory, { recursive: true });
  await rm(join(releaseDirectory, 'verified.json'), { force: true });
  const temporary = await mkdtemp(join(tmpdir(), 'capix-release-'));
  const archives = [];
  try {
    for (const entry of entries) {
      const filename = `${entry.manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${entry.manifest.version}.tgz`;
      const archive = join(releaseDirectory, filename);
      command('pnpm', ['pack', '--out', archive, '--json'], { cwd: entry.path, stdio: 'pipe' });
      const listing = command('tar', ['-tzf', archive], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n');
      assert.ok(
        listing.every((name) => name.startsWith('package/') && !name.includes('..') && !name.includes('\\')),
        `${entry.manifest.name}: unsafe archive path`,
      );
      const extraction = join(temporary, filename);
      await mkdir(extraction);
      command('tar', ['-xzf', archive, '-C', extraction]);
      const directory = join(extraction, 'package');
      const packed = await json(join(directory, 'package.json'));
      assert.equal(packed.name, entry.manifest.name);
      assert.equal(packed.version, entry.manifest.version);
      assert.equal(packed.private, false);
      assert.equal(packed.license, 'MIT');
      assert.equal(await readFile(join(directory, 'LICENSE'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8'));
      await readFile(join(directory, 'README.md'), 'utf8');
      const present = new Set();
      for (const file of await files(directory)) {
        const path = relative(directory, file).split('\\').join('/');
        present.add(path);
        assert.ok(['package.json', 'LICENSE', 'README.md'].includes(path) || /^dist\/.+\.(?:js|d\.ts)$/.test(path), `${packed.name}: unexpected published file ${path}`);
        if (path.endsWith('.js')) {
          const code = await readFile(file, 'utf8');
          assert.ok(code.startsWith(banner), `${packed.name}: JS was not prepared for release: ${path}`);
          assert.ok(!code.includes('sourceMappingURL='), `${packed.name}: source-map link in ${path}`);
        }
      }
      for (const target of Object.values(packed.exports)) {
        for (const kind of ['import', 'types']) {
          assert.ok(present.has(target[kind]?.replace(/^\.\//, '')), `${packed.name}: missing ${kind} export`);
        }
      }
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, version] of Object.entries(packed[field] ?? {})) {
          assert.ok(!/^(?:workspace|link|file):/.test(version), `${packed.name}: unresolved ${name}`);
          const internal = entries.find((item) => item.manifest.name === name);
          if (internal) assert.equal(version, internal.manifest.version, `${packed.name}: dependency does not match this release`);
        }
      }
      archives.push({
        name: packed.name,
        version: packed.version,
        file: filename,
        sha256: createHash('sha256')
          .update(await readFile(archive))
          .digest('hex'),
        exports: Object.keys(packed.exports),
      });
      console.log(`Verified ${filename}: ${present.size} files`);
    }
    const consumer = join(temporary, 'consumer');
    await mkdir(consumer);
    const workspace = await json(join(root, 'package.json'));
    const dependencies = Object.fromEntries(archives.map((entry) => [entry.name, `file:${join(releaseDirectory, entry.file)}`]));
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'release-consumer', private: true, type: 'module', dependencies, devDependencies: { typescript: workspace.devDependencies.typescript, '@types/node': workspace.devDependencies['@types/node'] } }, null, 2));
    command('npm', ['install', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund', '--prefer-offline', `--registry=${registry}`, '--fetch-timeout=20000', '--fetch-retries=1'], { cwd: consumer });
    command('npm', ['ls', '--all'], { cwd: consumer, stdio: 'pipe' });
    for (const fixture of ['consumer.mjs', 'consumer.ts']) await cp(join(root, 'scripts/release/fixtures', fixture), join(consumer, fixture));
    const imports = archives.flatMap((entry) => entry.exports.map((name) => entry.name + (name === '.' ? '' : name.slice(1))));
    await writeFile(join(consumer, 'exports.mjs'), `for (const name of ${JSON.stringify(imports)}) await import(name);\nconsole.log('Loaded ${imports.length} public exports from installed tarballs');\n`);
    command(process.execPath, ['exports.mjs'], { cwd: consumer });
    command(process.execPath, ['consumer.mjs'], { cwd: consumer });
    command(process.execPath, ['node_modules/typescript/bin/tsc', '--ignoreConfig', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2023,DOM,DOM.Iterable', '--skipLibCheck', 'false', 'consumer.ts'], { cwd: consumer });
    await writeFile(join(releaseDirectory, 'verified.json'), JSON.stringify({ packages: archives }, null, 2) + '\n');
    console.log(`Verified ${archives.length} tarballs in an isolated consumer; artifacts: ${relative(root, releaseDirectory)}`);
    return archives;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await check();
