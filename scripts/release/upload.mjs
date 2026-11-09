import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { command, registry } from './packages.mjs';

// Keep npm attached to the terminal from the first request so browser-based
// publishing authentication does not depend on Changesets' retry classification.
export async function upload(plan, directory, run = command) {
  for (const group of plan.plan) {
    for (const release of group) {
      assert.equal(release.kind, 'publish');
      assert.equal(release.access, 'public');
      assert.equal(release.tag, 'latest');
      assert.equal(basename(release.tarball.path), release.tarball.path);
      assert.ok(release.tarball.path.endsWith('.tgz'));
      const archive = join(directory, release.tarball.path);
      const digest = createHash('sha256')
        .update(await readFile(archive))
        .digest('base64');
      assert.equal(`sha256-${digest}`, release.tarball.integrity, `Artifact changed after verification: ${release.name}`);
      run('npm', ['publish', archive, '--access=public', '--tag=latest', `--registry=${registry}`, '--auth-type=web', '--ignore-scripts', '--provenance=false'], { stdio: 'inherit' });
    }
  }
}
