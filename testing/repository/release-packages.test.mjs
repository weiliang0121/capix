import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { packages, root } from '../../scripts/release/packages.mjs';

async function fixture(t, toolVersion = '0.8.0') {
  const directory = await mkdtemp(join(tmpdir(), 'capix-release-packages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entries = await packages();
  const license = await readFile(join(root, 'LICENSE'), 'utf8');
  await mkdir(join(directory, '.changeset'));
  await writeFile(join(directory, 'LICENSE'), license);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'release-fixture', private: true, version: '0.1.0', packageManager: 'pnpm@10.7.1' }));
  await writeFile(join(directory, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  // Formatting is checked separately; this offline fixture installs no tools.
  const config = { ...JSON.parse(await readFile(join(root, '.changeset/config.json'), 'utf8')), fixed: [], linked: [], format: false };
  await writeFile(join(directory, '.changeset/config.json'), JSON.stringify(config));
  for (const entry of entries) {
    const path = join(directory, entry.directory);
    await mkdir(path, { recursive: true });
    const manifest = { ...entry.manifest, version: entry.manifest.name === '@weiliang0121/capix-tool' ? toolVersion : '0.7.0' };
    await writeFile(join(path, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(path, 'LICENSE'), license);
    await writeFile(join(path, 'CHANGELOG.md'), `# ${manifest.name}\n\n## 0.7.0\n\nPrevious release.\n`);
  }
  return { directory, entries, config };
}

test('release inventory accepts independent versions and preserves the full public package boundary', async (t) => {
  const { directory } = await fixture(t);
  const entries = await packages(directory);
  assert.equal(entries.length, 18);
  assert.equal(entries.find((entry) => entry.manifest.name === '@weiliang0121/capix-tool').manifest.version, '0.8.0');
  assert.equal(entries.filter((entry) => entry.manifest.version === '0.7.0').length, 17);
  const tool = entries.find((entry) => entry.manifest.name === '@weiliang0121/capix-tool');
  for (const dependency of Object.keys(tool.manifest.dependencies).filter((name) => name.startsWith('@weiliang0121/capix-'))) {
    assert.equal(tool.manifest.dependencies[dependency], 'workspace:*');
    assert.equal(entries.find((entry) => entry.manifest.name === dependency).manifest.version, '0.7.0');
  }
  const extra = join(directory, 'packages/unlisted');
  await mkdir(extra);
  await writeFile(join(extra, 'package.json'), JSON.stringify({ name: '@weiliang0121/capix-unlisted', private: false }));
  await assert.rejects(packages(directory), /outside the release scope/);
});

test('independent releases reject fixed or linked groups and inaccurate internal dependency declarations', async (t) => {
  const { directory, config } = await fixture(t);
  for (const field of ['fixed', 'linked']) {
    await writeFile(join(directory, '.changeset/config.json'), JSON.stringify({ ...config, [field]: [['@weiliang0121/capix-tool', '@weiliang0121/capix-contracts']] }));
    await assert.rejects(packages(directory), new RegExp(`${field} release groups`));
  }
  await writeFile(join(directory, '.changeset/config.json'), JSON.stringify(config));
  const path = join(directory, 'packages/tool/package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.dependencies['@weiliang0121/capix-contracts'] = '0.8.0';
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(packages(directory), /target package version/);
});

test('a Tool-only changeset advances Tool alone and leaves seventeen package versions and changelogs intact', async (t) => {
  const { directory, entries } = await fixture(t, '0.7.0');
  const preserved = new Map();
  for (const entry of entries.filter((entry) => entry.manifest.name !== '@weiliang0121/capix-tool')) {
    for (const filename of ['package.json', 'CHANGELOG.md']) {
      const path = join(directory, entry.directory, filename);
      preserved.set(path, await readFile(path, 'utf8'));
    }
  }
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: directory, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd: directory, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=CAPiX test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Release fixture baseline'], { cwd: directory, stdio: 'pipe' });
  await writeFile(join(directory, '.changeset/tool-context.md'), "---\n'@weiliang0121/capix-tool': minor\n---\n\nAdd bounded request context; compatible with the existing 0.7.0 dependencies.\n");
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@changesets/cli/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const executable = join(dirname(manifestPath), manifest.bin.changeset);
  const planPath = join(directory, 'release-plan.json');
  try {
    execFileSync(process.execPath, [executable, 'status', '--output', planPath], { cwd: directory, stdio: 'pipe' });
  } catch (cause) {
    throw new Error(`Changesets status failed: ${cause.stdout?.toString()}${cause.stderr?.toString()}`, { cause });
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  assert.deepEqual(
    plan.releases.map(({ name, type, oldVersion, newVersion }) => ({ name, type, oldVersion, newVersion })),
    [{ name: '@weiliang0121/capix-tool', type: 'minor', oldVersion: '0.7.0', newVersion: '0.8.0' }],
  );
  try {
    execFileSync(process.execPath, [executable, 'version'], { cwd: directory, stdio: 'pipe' });
  } catch (cause) {
    throw new Error(`Changesets version failed: ${cause.stdout?.toString()}${cause.stderr?.toString()}`, { cause });
  }
  for (const [path, text] of preserved) assert.equal(await readFile(path, 'utf8'), text, path);
  assert.equal(JSON.parse(await readFile(join(directory, 'packages/tool/package.json'), 'utf8')).version, '0.8.0');
  const changelog = await readFile(join(directory, 'packages/tool/CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## 0\.8\.0[\s\S]*compatible with the existing 0\.7\.0 dependencies/);
  assert.doesNotMatch(changelog, /capix-contracts@0\.8\.0/);
});
