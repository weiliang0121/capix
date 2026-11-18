import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareBatch } from '../../scripts/release/batch.mjs';
import { packages, root } from '../../scripts/release/packages.mjs';

test('a squash version PR selects its exact artifacts and release sections in production dependency order', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'capix-version-pr-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.org', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: workspace, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init');
  await mkdir(join(workspace, '.changeset'));
  for (const file of ['LICENSE', 'package.json', '.changeset/config.json']) await copyFile(join(root, file), join(workspace, file));
  const entries = await packages();
  const archives = [];
  const directory = join(workspace, 'artifacts');
  await mkdir(directory);
  for (const { directory: packageDir, manifest } of entries) {
    const path = join(workspace, packageDir);
    await mkdir(path, { recursive: true });
    await copyFile(join(root, 'LICENSE'), join(path, 'LICENSE'));
    await writeFile(join(path, 'package.json'), JSON.stringify({ ...manifest, version: '1.0.0' }));
    const version = ['packages/memory', 'packages/view'].includes(packageDir) ? '1.1.0' : '1.0.0';
    const file = `${manifest.name.slice(1).replace('/', '-')}-${version}.tgz`;
    const sha256 = createHash('sha256').update(file).digest('hex');
    archives.push({ name: manifest.name, version, file, sha256 });
    await writeFile(join(directory, file), file);
  }
  git('add', 'LICENSE', 'package.json', '.changeset', 'packages');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  for (const { directory: packageDir, manifest } of entries) {
    if (!['packages/memory', 'packages/view'].includes(packageDir)) continue;
    const path = join(workspace, packageDir);
    await writeFile(join(path, 'package.json'), JSON.stringify({ ...manifest, version: '1.1.0' }));
    await writeFile(join(path, 'CHANGELOG.md'), `# ${manifest.name}\n\n## 1.1.0\n\n- New change for ${manifest.name}\n\n\`\`\`md\n## Example heading\n\`\`\`\n\nMigration guidance.\n\n## 1.0.0\n\nOlder text.\n`);
  }
  git('add', 'packages');
  git('commit', '-m', 'version packages');
  const source = git('rev-parse', 'HEAD');
  const inventory = join(directory, 'verified.json');
  await writeFile(inventory, JSON.stringify({ packages: archives }));
  const prepare = () => prepareBatch(base, source, '42', directory, workspace);
  await prepare();
  const selected = ['view', 'memory'].map((key) => archives.find(({ name }) => name === `@weiliang0121/capix-${key}`));
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8')), {
    schemaVersion: 1,
    source,
    pullRequest: 42,
    packages: selected.map(({ name, version, file }) => ({ name, version, file, integrity: `sha512-${createHash('sha512').update(file).digest('base64')}` })),
  });
  const notes = await readFile(join(directory, 'release-notes.md'), 'utf8');
  assert.match(notes, /capix-view@1\.1\.0[\s\S]+Migration guidance\.[\s\S]+capix-memory@1\.1\.0/);
  for (const { name, version } of selected) assert.ok(notes.includes(`https://www.npmjs.com/package/${name}/v/${version}`));
  assert.doesNotMatch(notes, /Older text/);
  await assert.rejects(prepareBatch(base.slice(0, 7), source, 42, directory, workspace), /full version PR base SHA/);
  await assert.rejects(prepareBatch(source, base, 42, directory, workspace), /exact version PR merge commit/);
  await assert.rejects(prepareBatch(source, source, 42, directory, workspace), /squash merge/);
  await writeFile(inventory, JSON.stringify({ packages: archives.slice(1) }));
  await assert.rejects(prepare(), /Incomplete verified package inventory/);
  await writeFile(inventory, JSON.stringify({ packages: archives }));
  await writeFile(join(directory, selected[0].file), 'changed bytes');
  await assert.rejects(prepare(), /changed after verification/);
  await writeFile(join(directory, selected[0].file), selected[0].file);
  await writeFile(join(workspace, 'packages/view/CHANGELOG.md'), '## 1.0.0\n\nPrevious release only.\n');
  git('commit', '-am', 'omit changelog entry', '--amend');
  await assert.rejects(prepareBatch(base, git('rev-parse', 'HEAD'), 42, directory, workspace), /latest CHANGELOG section/);

  const view = entries.find(({ directory }) => directory === 'packages/view');
  await writeFile(join(workspace, 'packages/view/package.json'), JSON.stringify({ ...view.manifest, version: '0.9.0' }));
  git('commit', '-am', 'decrease version', '--amend');
  await writeFile(inventory, JSON.stringify({ packages: archives.map((archive) => (archive.name === view.manifest.name ? { ...archive, version: '0.9.0' } : archive)) }));
  await assert.rejects(prepareBatch(base, git('rev-parse', 'HEAD'), 42, directory, workspace), /Version must increase/);
});
