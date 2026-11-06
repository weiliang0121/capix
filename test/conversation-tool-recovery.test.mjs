import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/conversation-tool-recovery.mjs', import.meta.url));
function run(mode, path, boundary) {
  const child = spawnSync(process.execPath, [fixture, mode, path, ...(boundary ? [boundary] : [])], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(child.error);
  assert.ok(child.stdout.trim(), child.stderr);
  return { status: child.status, report: JSON.parse(child.stdout), stderr: child.stderr };
}
function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-tool-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'conversation.sqlite');
}
for (const boundary of ['prepared', 'initialized', 'feedback', 'tool', 'tool-feedback', 'assistant', 'memory']) {
  test(`tool conversation resumes a real process loss after ${boundary} without repeated requests or effects`, (t) => {
    const path = database(t);
    const crashed = run('crash', path, boundary);
    assert.equal(crashed.status, 73, JSON.stringify(crashed));
    const listed = run('list', path);
    assert.equal(listed.status, 0, JSON.stringify(listed));
    assert.equal(listed.report.result[0].available, false);
    assert.equal(listed.report.result[0].eligibility, 'unchecked');
    assert.equal(listed.report.archiveReads, 0);
    assert.equal(listed.report.interactionReads, 0);
    const resumed = run('resume', path);
    assert.equal(resumed.status, 0, JSON.stringify(resumed));
    assert.equal(resumed.report.result, '你此前提到喜欢成都川菜。');
    assert.deepEqual(resumed.report.requests, ['tools', 'answer', 'memory']);
    assert.equal(resumed.report.state.transcript.messages.length, 3);
    assert.equal(resumed.report.state.transcript.appends.length, 1);
    assert.equal(resumed.report.state.memories.items.length, 1);
    assert.equal(resumed.report.state.memories.applies.length, 1);
    assert.equal(resumed.report.collections.length, 1);
    assert.equal(resumed.report.collections[0].entries, 2);
    assert.equal(resumed.report.roots[0].status, 'succeeded');
    assert.equal(resumed.report.loaded, 0);
    if (boundary === 'tool-feedback')
      assert.equal(
        resumed.report.stages.some((stage) => stage.kind === 'tool'),
        false,
        'restored delivery is not newly running tool activity',
      );
    if (boundary === 'assistant' || boundary === 'memory') assert.deepEqual(resumed.report.stages, [], 'closed tool history is not replayed as current activity');
    const again = run('resume', path);
    assert.equal(again.status, 1);
    assert.deepEqual(again.report.requests, resumed.report.requests);
    assert.deepEqual(again.report.state, resumed.report.state);
  });
}
for (const boundary of ['waiting', 'missing-feedback', 'missing-memory-feedback']) {
  test(`tool recovery refuses ${boundary}, never filling an unknown dispatch gap`, (t) => {
    const path = database(t);
    const crashed = run('crash', path, boundary);
    assert.equal(crashed.status, 73, JSON.stringify(crashed));
    const resumed = run('resume', path);
    assert.equal(resumed.status, 1, JSON.stringify(resumed));
    assert.equal(resumed.report.error.code, 'CHECKPOINT_CONTENT_CHANGED');
    assert.deepEqual(resumed.report.requests, crashed.report.requests);
    assert.deepEqual(resumed.report.state, crashed.report.state);
    assert.equal(resumed.report.loaded, 0);
  });
}
for (const mode of ['changed-configuration', 'changed-policy', 'changed-budget', 'new-input', 'missing-archive']) {
  test(`tool recovery rejects ${mode} without starting another request`, (t) => {
    const path = database(t);
    assert.equal(run('crash', path, 'feedback').status, 73);
    const rejected = run(mode, path);
    assert.equal(rejected.status, 1, JSON.stringify(rejected));
    assert.equal(rejected.report.error.code, 'CHECKPOINT_CONTENT_CHANGED');
    assert.deepEqual(rejected.report.requests, ['tools']);
    assert.equal(rejected.report.loaded, 0);
  });
}
for (const mode of ['archive-read-failure', 'interaction-read-failure']) {
  test(`tool recovery preserves original ${mode} instead of disguising it as an eligibility failure`, (t) => {
    const path = database(t);
    assert.equal(run('crash', path, 'feedback').status, 73);
    const rejected = run(mode, path);
    assert.equal(rejected.status, 1, JSON.stringify(rejected));
    assert.equal(rejected.report.error.persistence, true);
    assert.deepEqual(rejected.report.requests, ['tools']);
    assert.equal(rejected.report.loaded, 0);
  });
}

for (const mode of ['changed-model-reference', 'changed-model-request', 'changed-model-reply', 'changed-preparation', 'changed-feedback', 'changed-intake-operation']) {
  test(`tool recovery certifies original facts and refuses ${mode}`, (t) => {
    const path = database(t);
    const crashed = run('crash', path, 'assistant');
    assert.equal(crashed.status, 73);
    const rejected = run(mode, path);
    assert.equal(rejected.status, 1, JSON.stringify(rejected));
    assert.equal(rejected.report.error.code, 'CHECKPOINT_CONTENT_CHANGED');
    assert.deepEqual(rejected.report.requests, ['tools', 'answer']);
    assert.deepEqual(rejected.report.state, crashed.report.state);
    assert.equal(rejected.report.loaded, 0);
  });
}

test('tool preparation recovery uses the original active memory selection, retaining inactive entity facts separately', (t) => {
  const path = database(t);
  const crashed = run('crash', path, 'active-memory');
  assert.equal(crashed.status, 73, JSON.stringify(crashed));
  const original = crashed.report.state.memories.items;
  assert.equal(original.length, 2);
  const resumed = run('resume', path);
  assert.equal(resumed.status, 0, JSON.stringify(resumed));
  assert.deepEqual(resumed.report.requests, ['tools', 'answer', 'memory']);
  assert.equal(resumed.report.state.memories.items.length, 3);
  assert.deepEqual(resumed.report.state.memories.items.slice(0, 2), original);
  assert.equal(
    resumed.report.state.view.members.some((item) => item.source === 'memories' && item.key === original[1].id),
    false,
  );
});
