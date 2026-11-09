import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// Changesets 3's publish plan is versioned. Only attach artifacts we just installed
// and tested; do not allow the registry plan to choose another file or package.
export async function verifiedPlan(plan, archives, directory) {
  assert.equal(plan.version, 1, 'Unsupported Changesets publish plan');
  assert.ok(Array.isArray(plan.plan), 'Missing publish groups');
  const artifacts = new Map(archives.map((archive) => [archive.name, archive]));
  assert.equal(artifacts.size, archives.length, 'Duplicate verified package');
  const selected = new Set();
  const groups = [];
  for (const group of plan.plan) {
    assert.ok(Array.isArray(group), 'Invalid publish group');
    const releases = [];
    for (const release of group) {
      assert.equal(release.kind, 'publish', 'Only public package publication is supported');
      const archive = artifacts.get(release.name);
      assert.ok(archive, `Unverified package: ${release.name}`);
      assert.ok(!selected.has(release.name), `Duplicate planned package: ${release.name}`);
      selected.add(release.name);
      assert.equal(release.version, archive.version, 'Plan version differs from tested artifact');
      assert.equal(release.access, 'public', 'Only public packages are supported');
      assert.equal(release.tag, 'latest', 'Prerelease publishing needs a separate release policy');
      assert.equal(basename(archive.file), archive.file, 'Artifact must be in the release directory');
      assert.ok(archive.file.endsWith('.tgz'), 'Expected a packed artifact');
      const digest = createHash('sha256')
        .update(await readFile(join(directory, archive.file)))
        .digest('hex');
      assert.equal(digest, archive.sha256, `Artifact changed after verification: ${release.name}`);
      releases.push({ kind: 'publish', name: release.name, version: release.version, access: 'public', tag: 'latest', tarball: { path: archive.file, integrity: `sha256-${Buffer.from(digest, 'hex').toString('base64')}` } });
    }
    groups.push(releases);
  }
  return { version: 1, plan: groups };
}
