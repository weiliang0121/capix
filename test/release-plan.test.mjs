import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifiedPlan } from '../scripts/release/plan.mjs';

test('publication uses the exact verified artifact and preserves dependency groups', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'release-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const content = 'verified package bytes';
  const archive = { name: '@example/contracts', version: '0.1.0', file: 'contracts.tgz', sha256: createHash('sha256').update(content).digest('hex') };
  await writeFile(join(directory, archive.file), content);
  const release = { kind: 'publish', name: archive.name, version: archive.version, access: 'public', tag: 'latest' };
  const plan = { version: 1, plan: [[release]] };
  const result = await verifiedPlan(plan, [archive], directory);
  assert.deepEqual(
    result.plan.map((group) => group.map((entry) => entry.name)),
    [[archive.name]],
  );
  assert.equal(result.plan[0][0].tarball.path, archive.file);
  assert.equal(result.plan[0][0].tarball.integrity, `sha256-${Buffer.from(archive.sha256, 'hex').toString('base64')}`);
  // Already published versions can be absent from the registry's remaining plan.
  assert.deepEqual(await verifiedPlan({ version: 1, plan: [] }, [archive], directory), { version: 1, plan: [] });
  await assert.rejects(verifiedPlan({ version: 1, plan: [[{ ...release, name: '@example/service' }]] }, [archive], directory), /Unverified package/);
  await assert.rejects(verifiedPlan({ version: 1, plan: [[{ ...release, version: '0.2.0' }]] }, [archive], directory), /version differs/);
  await assert.rejects(verifiedPlan({ version: 1, plan: [[{ ...release, access: 'restricted' }]] }, [archive], directory), /public packages/);
  await assert.rejects(verifiedPlan({ version: 1, plan: [[release, release]] }, [archive], directory), /Duplicate planned/);
  await writeFile(join(directory, archive.file), 'different package bytes');
  await assert.rejects(verifiedPlan(plan, [archive], directory), /changed after verification/);
});
