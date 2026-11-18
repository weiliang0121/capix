import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSource } from '../../scripts/release/source.mjs';

function fixture() {
  const base = 'a'.repeat(40);
  const source = 'b'.repeat(40);
  const repo = { full_name: 'owner/capix' };
  const env = { VERSION_PR: '23', GITHUB_REPOSITORY: repo.full_name, GITHUB_SHA: source, GITHUB_EVENT_NAME: 'workflow_dispatch' };
  const pr = { number: 23, merged: true, merged_at: '2026-08-01T00:00:00Z', state: 'closed', base: { repo, ref: 'main' }, head: { repo, ref: 'changeset-release/main' }, merge_commit_sha: source };
  const routes = new Map([['repos/owner/capix/pulls/23', pr]]);
  const list = (page) => `repos/owner/capix/commits/${source}/pulls?per_page=100&page=${page}`;
  const commands = new Map([
    ['rev-parse HEAD', source],
    [`show -s --format=%P ${source}`, base],
  ]);
  const read = (map, key) => {
    assert.ok(map.has(key), `Unexpected read: ${key}`);
    return map.get(key);
  };
  const push = () => {
    env.GITHUB_EVENT_NAME = 'push';
    env.VERSION_PR = '';
  };
  const expected = { eligible: true, pr: 23, source, base, artifact: `release-pr-23-${source}` };
  return {
    base,
    source,
    env,
    pr,
    routes,
    list,
    commands,
    push,
    expected,
    resolve: () =>
      resolveSource(
        env,
        (route) => read(routes, route),
        (...args) => read(commands, args.join(' ')),
      ),
  };
}

test('manual publication binds the version PR to the exact triggering commit', () => {
  const f = fixture();
  assert.deepEqual(f.resolve(), f.expected);
  for (const value of ['', '00', '-1', '1.5', '2/3', '9007199254740992', '1\nextra=true']) {
    f.env.VERSION_PR = value;
    assert.throws(f.resolve, /positive decimal|Invalid/);
  }
});

test('pushes use all associated PR pages and select only the exact version merge', () => {
  const f = fixture();
  f.push();
  const other = { ...f.pr, number: 24, merge_commit_sha: f.base };
  f.routes.set(f.list(1), Array(100).fill(other));
  f.routes.set(f.list(2), []);
  assert.deepEqual(f.resolve(), { eligible: false });
  f.routes.set(f.list(2), [{ ...f.pr, merged: undefined }]);
  assert.deepEqual(f.resolve(), f.expected);
  f.routes.set(f.list(2), [f.pr, { ...f.pr, number: 25 }]);
  assert.throws(f.resolve, /Multiple merged version PRs/);
});

test('push discovery skips ordinary merges and manual input must match the same merged version PR', () => {
  for (const mutate of [(f) => (f.pr.merged_at = null), (f) => (f.pr.state = 'open'), (f) => (f.pr.base.ref = 'feature'), (f) => (f.pr.base.repo = { full_name: 'fork/capix' }), (f) => (f.pr.head.repo = { full_name: 'fork/capix' }), (f) => (f.pr.head.ref = 'ordinary'), (f) => (f.pr.merge_commit_sha = f.base)]) {
    const f = fixture();
    mutate(f);
    assert.throws(f.resolve, /version PR at the triggering main SHA/);
    f.push();
    f.routes.set(f.list(1), [f.pr]);
    assert.deepEqual(f.resolve(), { eligible: false });
  }
});

test('reject an incorrect checkout, malformed response, unmerged PR or multi-parent merge', () => {
  const f = fixture();
  f.commands.set('rev-parse HEAD', f.base);
  assert.throws(f.resolve, /triggering main commit/);
  f.commands.set('rev-parse HEAD', f.source);
  f.commands.set(`show -s --format=%P ${f.source}`, `${f.base} ${f.base}`);
  assert.throws(f.resolve, /one parent/);
  f.pr.merged = false;
  assert.throws(f.resolve, /merged same-repository version PR/);
  f.push();
  f.routes.set(f.list(1), { error: true });
  assert.throws(f.resolve, /Invalid associated PR response/);
});
