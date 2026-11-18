import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function id(input, label) {
  assert.equal(typeof input, 'string', `Expected ${label}`);
  assert.match(input, /^[1-9]\d*$/, `Expected a positive decimal ${label}`);
  assert.ok(Number.isSafeInteger(Number(input)), `Invalid ${label}`);
  return Number(input);
}

function readCommand(file, args) {
  return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function versionMerge(pr, repository, dispatch) {
  return pr.state === 'closed' && Boolean(pr.merged_at) && pr.merge_commit_sha === dispatch && pr.base?.repo?.full_name === repository && pr.base.ref === 'main' && pr.head?.repo?.full_name === repository && pr.head.ref === 'changeset-release/main';
}

function findVersionPR(api, path, repository, dispatch) {
  let selected;
  for (let page = 1; ; page++) {
    const prs = api(`${path}/commits/${dispatch}/pulls?per_page=100&page=${page}`);
    assert.ok(Array.isArray(prs), 'Invalid associated PR response');
    for (const pr of prs) {
      if (!versionMerge(pr, repository, dispatch)) continue;
      assert.equal(selected, undefined, 'Multiple merged version PRs for the triggering commit');
      assert.ok(Number.isSafeInteger(pr.number) && pr.number > 0, 'Invalid associated PR number');
      selected = pr.number;
    }
    if (prs.length < 100) return selected;
  }
}

export function resolveSource(env, api = (route) => JSON.parse(readCommand('gh', ['api', route])), git = (...args) => readCommand('git', args)) {
  const repository = env.GITHUB_REPOSITORY;
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/, 'Invalid GitHub repository');
  const source = env.GITHUB_SHA;
  const sha = /^[a-f0-9]{40}$/;
  assert.match(source, sha, 'Expected the triggering main commit');
  assert.equal(git('rev-parse', 'HEAD'), source, 'Check out the triggering main commit');
  const path = `repos/${repository}`;
  const manual = env.VERSION_PR || env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const prNumber = manual ? id(env.VERSION_PR, 'version PR number') : findVersionPR(api, path, repository, source);
  if (prNumber === undefined) return { eligible: false };
  const pr = api(`${path}/pulls/${prNumber}`);
  assert.equal(pr.number, prNumber, 'Unexpected version PR number');
  assert.ok(pr.merged === true && versionMerge(pr, repository, source), 'Expected a merged same-repository version PR at the triggering main SHA');
  const base = git('show', '-s', '--format=%P', source);
  assert.match(base, sha, 'Expected a squash merge with one parent');
  return { eligible: true, pr: prNumber, source, base, artifact: `release-pr-${prNumber}-${source}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputs = resolveSource(process.env);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}
