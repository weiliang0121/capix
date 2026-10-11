import assert from 'node:assert/strict';
import test from 'node:test';
import filesystem, { mkdtemp, writeFile, mkdir, symlink, rm, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceFiles, FileAccessException, FileResources } from '@capix/observer-service/assembly';
import { CheckFileTaskDefinition } from '@capix/observer-service/conversation';
import { bindResources, InvocationCancelled } from '@capix/server-runtime';
import { Transcript } from '@capix/server-runtime/content';
import { createBoundRuntime } from '../fixtures/runtime.mjs';
import { bindChild } from '../fixtures/observer.mjs';
import { callFor, lifecycleFor, invoke } from '../fixtures/lifecycle.mjs';

async function workspace(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'capix-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, files: new WorkspaceFiles({ root, ...options }) };
}

test('preflight normalizes only absolute paths within the configured root and returns immutable relative facts', async (t) => {
  const { root, files } = await workspace(t);
  await writeFile(join(root, 'source.md'), 'private text');
  const task = { sourcePath: join(root, 'source.md'), output: { path: join(root, 'result.md') } };
  const result = await files.checkTask(task);
  assert.deepEqual(result, { kind: 'ready', task: { sourcePath: 'source.md', output: { path: 'result.md' } } });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.task));
  assert.ok(Object.isFrozen(result.task.output));
  assert.equal(task.sourcePath, join(root, 'source.md'));
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal((await files.checkTask({ sourcePath: `${root}-other/source.md` })).reason, 'outside');
  assert.equal((await files.checkTask({ sourcePath: root })).reason, 'outside');
});

test('candidate defects ask the decider to revise, without pretending user information is missing', async (t) => {
  const { files } = await workspace(t);
  for (const task of [{ sourcePath: '../source.md' }, { sourcePath: './source.md' }, { sourcePath: 'x//source.md' }, { sourcePath: 'x\\source.md' }, { sourcePath: 'source.md', output: { path: 'source.md' } }]) {
    assert.equal((await files.checkTask(task)).kind, 'revise');
  }
});

test('preflight checks source metadata and output availability without reading or writing contents', async (t) => {
  const { root, files } = await workspace(t);
  await writeFile(join(root, 'source.md'), 'secret');
  const patches = ['open', 'readFile', 'readdir', 'writeFile', 'link'].map((method) => t.mock.method(filesystem, method, () => assert.fail(`preflight called ${method}`)));
  syncBuiltinESMExports();
  try {
    assert.equal((await files.checkTask({ sourcePath: 'source.md', output: { path: 'result.md' } })).kind, 'ready');
    assert.equal((await files.checkTask({ output: { path: 'generated.md' } })).kind, 'ready');
  } finally {
    for (const patch of patches) patch.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readdir(root), ['source.md']);
});

test('known unavailable paths produce specific needs-input evidence', async (t) => {
  const { root, files } = await workspace(t, { maxReadBytes: 4 });
  await writeFile(join(root, 'large.md'), '12345');
  await writeFile(join(root, 'existing.md'), 'text');
  await mkdir(join(root, 'folder'));
  await symlink(join(root, 'existing.md'), join(root, 'link.md'));
  await symlink(join(root, 'folder'), join(root, 'linked-folder'));
  for (const [task, reason] of [
    [{ sourcePath: 'missing.md' }, 'source-missing'],
    [{ sourcePath: 'large.md' }, 'too-large'],
    [{ sourcePath: 'folder' }, 'not-file'],
    [{ sourcePath: 'link.md' }, 'symbolic-link'],
    [{ output: { path: 'linked-folder/new.md' } }, 'symbolic-link'],
    [{ output: { path: 'existing.md' } }, 'exists'],
    [{ output: { path: 'missing/new.md' } }, 'directory-missing'],
  ]) {
    const result = await files.checkTask(task);
    assert.equal(result.kind, 'needs-input');
    assert.equal(result.reason, reason);
  }
});

test('explicit file constraints reject widening before filesystem inspection', async (t) => {
  const { root, files } = await workspace(t);
  const constraint = { sourcePath: 'source.md' };
  const patch = t.mock.method(filesystem, 'realpath', () => assert.fail('conflicting task reached filesystem'));
  syncBuiltinESMExports();
  try {
    for (const task of [{ sourcePath: 'other.md' }, { sourcePath: 'source.md', output: { path: 'new.md' } }, { output: { path: 'new.md' } }]) {
      assert.deepEqual(await files.checkTask(task, { constraint }), { kind: 'revise', reason: 'constraint', feedback: '候选来源、目标和是否保存必须完整符合本次显式文件任务，不能自行增删或替换。' });
    }
  } finally {
    patch.mock.restore();
    syncBuiltinESMExports();
  }
  await writeFile(join(root, 'source.md'), 'text');
  assert.equal((await files.checkTask({ sourcePath: join(root, 'source.md') }, { constraint })).kind, 'ready');
});

test('permission, IO and unavailable workspace failures do not become decision feedback', async (t) => {
  const { root, files } = await workspace(t);
  const actualRoot = await filesystem.realpath(root);
  const original = filesystem.lstat;
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    const failure = Object.assign(new Error('inspection unavailable'), { code });
    const patch = t.mock.method(filesystem, 'lstat', (path, ...args) => {
      if (path === join(actualRoot, 'source.md')) throw failure;
      return original(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(files.checkTask({ sourcePath: 'source.md' }), (error) => error.contract === FileAccessException && error.cause === failure);
    } finally {
      patch.mock.restore();
      syncBuiltinESMExports();
    }
  }
  const missing = new WorkspaceFiles({ root: join(root, 'missing-workspace') });
  await assert.rejects(missing.checkTask({ sourcePath: 'source.md' }), (error) => error.contract === FileAccessException);
});

test('a workspace disappearing between preflight root checks remains an environment failure', async (t) => {
  const { root, files } = await workspace(t);
  for (const code of ['ENOENT', 'ENOTDIR']) {
    let checks = 0;
    const original = filesystem.realpath;
    const failure = Object.assign(new Error('workspace disappeared'), { code });
    const patch = t.mock.method(filesystem, 'realpath', (path, ...args) => {
      if (path === root && ++checks === 2) throw failure;
      return original(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(files.checkTask({ sourcePath: 'source.md' }), (error) => error.contract === FileAccessException && error.facts.reason === 'workspace-unavailable' && error.cause === failure);
      assert.equal(checks, 2);
    } finally {
      patch.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test('a workspace becoming a non-directory is not reported as a missing task directory', async (t) => {
  const { root, files } = await workspace(t);
  const actualRoot = await filesystem.realpath(root);
  const original = filesystem.lstat;
  let checks = 0;
  const patch = t.mock.method(filesystem, 'lstat', (path, ...args) => {
    if (path === actualRoot && ++checks === 2) return Promise.resolve({ isDirectory: () => false });
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(files.checkTask({ output: { path: 'result.md' } }), (error) => error.contract === FileAccessException && error.facts.reason === 'workspace-unavailable');
  } finally {
    patch.mock.restore();
    syncBuiltinESMExports();
  }
});

test('preflight cancellation remains cancellation even if filesystem returned metadata', async (t) => {
  const { root, files } = await workspace(t);
  await writeFile(join(root, 'source.md'), 'text');
  const actualRoot = await filesystem.realpath(root);
  const controller = new AbortController();
  const original = filesystem.lstat;
  const patch = t.mock.method(filesystem, 'lstat', async (path, ...args) => {
    const result = await original(path, ...args);
    if (path === join(actualRoot, 'source.md')) controller.abort('stop');
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(files.checkTask({ sourcePath: 'source.md' }, { signal: controller.signal }), (error) => error instanceof InvocationCancelled && error.belongsTo(controller.signal));
  } finally {
    patch.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a real inspection fault is not hidden by a concurrent cancellation', async (t) => {
  const { root, files } = await workspace(t);
  const actualRoot = await filesystem.realpath(root);
  const controller = new AbortController();
  const original = filesystem.lstat;
  const failure = Object.assign(new Error('IO failed'), { code: 'EIO' });
  const patch = t.mock.method(filesystem, 'lstat', (path, ...args) => {
    if (path === join(actualRoot, 'source.md')) {
      controller.abort('stop');
      throw failure;
    }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(files.checkTask({ sourcePath: 'source.md' }, { signal: controller.signal }), (error) => error.contract === FileAccessException && error.cause === failure);
  } finally {
    patch.mock.restore();
    syncBuiltinESMExports();
  }
});

test('ready is not a reservation and actual write still refuses a subsequently created target', async (t) => {
  const { root, files } = await workspace(t);
  assert.equal((await files.checkTask({ output: { path: 'result.md' } })).kind, 'ready');
  await writeFile(join(root, 'result.md'), 'other writer');
  await assert.rejects(files.createText('result.md', 'ours'), (error) => error.contract === FileAccessException && error.facts.reason === 'exists');
});

test('inspector resource has a narrow endpoint, enforces the supplied constraint and call lifetime', async (t) => {
  const { root, files } = await workspace(t);
  await writeFile(join(root, 'source.md'), 'private body');
  const request = FileResources.inspect.request();
  const observations = [];
  const resources = bindResources({ inspector: request }, [FileResources.inspect.provide((source) => source)])({ files, constraint: { sourcePath: 'source.md' } });
  let active = true;
  resources.attach({
    contextId: 'preflight-call',
    validate: () => assert.ok(active, 'call closed'),
    observation: {
      publish(fact) {
        observations.push(fact.describe());
      },
    },
  });
  resources.start();
  const inspector = resources.values.inspector;
  assert.deepEqual(Object.keys(inspector), ['inspect']);
  assert.equal((await inspector.inspect({ sourcePath: 'other.md' })).reason, 'constraint');
  assert.equal((await inspector.inspect({ sourcePath: 'source.md' })).kind, 'ready');
  assert.equal(JSON.stringify(observations).includes(root), false);
  assert.equal(JSON.stringify(observations).includes('private body'), false);
  active = false;
  await assert.rejects(inspector.inspect({ sourcePath: 'source.md' }), /call closed/);
});

test('preflight O accepts the real inspect A result and preserves the content instruction', async (t) => {
  const { root, files } = await workspace(t);
  await writeFile(join(root, 'source.md'), 'text');
  const runtime = createBoundRuntime();
  const definition = new CheckFileTaskDefinition();
  const operation = bindChild(runtime, definition);
  const binding = bindResources(CheckFileTaskDefinition.requires, [FileResources.inspect.provide((source) => source)]);
  const transcript = new Transcript([{ role: 'user', content: 'translate source.md' }]);
  const input = { task: { sourcePath: join(root, 'source.md') }, instruction: '翻译成白话文' };
  const result = await invoke(lifecycleFor(runtime).execution({ input: transcript.get(0), transcript, resourceBinding: () => binding({ files }), settings: {} }), (context) => operation.call(callFor(context), input));
  assert.deepEqual(result, { kind: 'ready', task: { sourcePath: 'source.md' }, instruction: '翻译成白话文' });
  assert.equal(transcript.length, 1);
});
