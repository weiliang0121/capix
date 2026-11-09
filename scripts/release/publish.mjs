import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { check } from './check.mjs';
import { command, json, registry, releaseDirectory } from './packages.mjs';
import { verifiedPlan } from './plan.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'capix-publish-'));
try {
  assert.equal(command('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: 'pipe' }).trim(), '', 'Commit and review release changes before publishing');
  const plan = join(temporary, 'plan.json');
  command('pnpm', ['exec', 'changeset', 'status', '--output', plan]);
  assert.equal((await json(plan)).releases.length, 0, 'Run release:version and review its changes before publishing');
  const archives = await check();
  const environment = { ...process.env, npm_config_registry: registry, NPM_CONFIG_PROVENANCE: 'false', npm_config_provenance: 'false' };
  const publication = join(temporary, 'publication.json');
  command('pnpm', ['exec', 'changeset', 'publish-plan', '--output', publication], { env: environment });
  const verified = await verifiedPlan(await json(publication), archives, releaseDirectory);
  await writeFile(join(releaseDirectory, 'publish-plan.json'), JSON.stringify(verified, null, 2) + '\n');
  command('pnpm', ['exec', 'changeset', 'publish', '--from-pack-dir', releaseDirectory], { env: environment });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
