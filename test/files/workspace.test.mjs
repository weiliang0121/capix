import assert from 'node:assert/strict';
import { test } from 'node:test';
import filesystem, { mkdtemp, writeFile, readFile, mkdir, symlink, readdir, rm, open, rename } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkspaceFiles, FileAccessException, FileResources, isRelativeFilePath } from '@capix/observer-service/assembly';
import { ProgressChannel, InvocationCancelled, bindResources } from '@capix/server-runtime';

async function workspace(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'capix-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, files: new WorkspaceFiles({ root, ...options }) };
}
function channel(facts, receive) {
  return new ProgressChannel({
    receive(fact) {
      facts.push(fact);
      receive?.(fact);
    },
  });
}
function isFailure(reason) {
  return (error) => error.contract === FileAccessException && error.facts.reason === reason;
}

test('file path spelling is canonical, relative, and portable', () => {
  for (const value of ['input.txt', 'folder/资料.md', ' name with spaces.txt']) assert.equal(isRelativeFilePath(value), true);
  for (const value of [null, 1, '', '/etc/passwd', '../input', 'folder/../input', './input', 'folder//input', 'folder/', 'C:/input', 'folder\\input', 'input\n.txt', 'a'.repeat(1025)]) assert.equal(isRelativeFilePath(value), false);
});

test('constructing optional file workspace performs no IO and read returns immutable actual-byte evidence', async (t) => {
  assert.doesNotThrow(() => new WorkspaceFiles({ root: '/missing/capix-file-workspace' }));
  const { root, files } = await workspace(t);
  const text = '文字证据\nsecond line\n';
  await writeFile(join(root, 'input.md'), text);
  const value = await files.readText('input.md');
  assert.deepEqual(value, { path: 'input.md', text, bytes: Buffer.byteLength(text), digest: createHash('sha256').update(text).digest('hex') });
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(files.configuration));
});

test('bounded read rejects missing files, traversal, directories, invalid UTF-8 and oversized text', async (t) => {
  const { root, files } = await workspace(t, { maxReadBytes: 8 });
  await writeFile(join(root, 'large.txt'), 'a'.repeat(9));
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await writeFile(join(root, 'binary.txt'), Buffer.from([0x61, 0]));
  await mkdir(join(root, 'folder'));
  await assert.rejects(files.readText('missing.txt'), isFailure('unavailable'));
  await assert.rejects(files.readText('../outside.txt'), isFailure('path'));
  await assert.rejects(files.readText('folder'), isFailure('not-file'));
  await assert.rejects(files.readText('large.txt'), isFailure('too-large'));
  await assert.rejects(files.readText('invalid.txt'), isFailure('encoding'));
  await assert.rejects(files.readText('binary.txt'), isFailure('encoding'));
  await writeFile(join(root, 'exact.txt'), '12345678');
  assert.equal((await files.readText('exact.txt')).bytes, 8);
});

test('symlink files and intermediate directories cannot expose files outside or inside the root', async (t) => {
  const { root, files } = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), 'capix-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await writeFile(join(root, 'local.txt'), 'local');
  await symlink(join(outside, 'secret.txt'), join(root, 'outside.txt'));
  await symlink(join(root, 'local.txt'), join(root, 'inside.txt'));
  await symlink(outside, join(root, 'directory'));
  await assert.rejects(files.readText('outside.txt'), isFailure('symbolic-link'));
  await assert.rejects(files.readText('inside.txt'), isFailure('symbolic-link'));
  await assert.rejects(files.readText('directory/secret.txt'), isFailure('symbolic-link'));
  await assert.rejects(files.createText('directory/output.txt', 'answer'), isFailure('symbolic-link'));
  assert.deepEqual(await readdir(outside), ['secret.txt']);
});

test('a workspace identity cannot silently switch to a replacement root', async (t) => {
  const { root, files } = await workspace(t);
  await writeFile(join(root, 'input.txt'), 'first');
  await files.readText('input.txt');
  const previous = `${root}-moved`;
  await rename(root, previous);
  t.after(() => rm(previous, { recursive: true, force: true }));
  await mkdir(root);
  await writeFile(join(root, 'input.txt'), 'replacement');
  await assert.rejects(files.readText('input.txt'), isFailure('changed'));
  await assert.rejects(files.createText('output.txt', 'answer'), isFailure('changed'));
});

test('new file publication is complete, exclusive, and emits receipt before cleanup', async (t) => {
  const { root, files } = await workspace(t);
  const facts = [];
  const receipt = await files.createText('output.md', '模型结果', { progress: channel(facts) });
  assert.deepEqual(
    facts.map((fact) => fact.kind),
    ['started', 'created'],
  );
  assert.equal(facts[1].receipt, receipt);
  assert.equal(await readFile(join(root, 'output.md'), 'utf8'), '模型结果');
  assert.ok(Object.isFrozen(receipt));
  assert.deepEqual(await readdir(root), ['output.md']);
  const second = [];
  await assert.rejects(files.createText('output.md', 'replace', { progress: channel(second) }), isFailure('exists'));
  assert.deepEqual(
    second.map((fact) => fact.kind),
    ['started', 'not-created'],
  );
  assert.equal(await readFile(join(root, 'output.md'), 'utf8'), '模型结果');
  assert.deepEqual(await readdir(root), ['output.md']);
});

test('concurrent create calls cannot overwrite one another or expose partial output', async (t) => {
  const { root, files } = await workspace(t);
  const results = await Promise.allSettled([files.createText('output.txt', 'first'), files.createText('output.txt', 'second')]);
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
  const text = await readFile(join(root, 'output.txt'), 'utf8');
  assert.ok(text === 'first' || text === 'second');
  assert.deepEqual(await readdir(root), ['output.txt']);
});

test('create rejects oversized/invalid output and does not create missing directories', async (t) => {
  const { root, files } = await workspace(t, { maxWriteBytes: 8 });
  await assert.rejects(files.createText('large.txt', '123456789'), isFailure('too-large'));
  await assert.rejects(files.createText('nul.txt', 'a\0b'), isFailure('encoding'));
  await assert.rejects(files.createText('surrogate.txt', '\ud800'), isFailure('encoding'));
  await assert.rejects(files.createText('new/output.txt', 'answer'), isFailure('unavailable'));
  assert.deepEqual(await readdir(root), []);
});

test('cancel before publication produces no target and preserves cancellation classification', async (t) => {
  const { root, files } = await workspace(t);
  const controller = new AbortController();
  const facts = [];
  const progress = channel(facts, (fact) => {
    if (fact.kind === 'started') controller.abort('stop before write');
  });
  await assert.rejects(files.createText('cancelled.txt', 'answer', { signal: controller.signal, progress }), (error) => error instanceof InvocationCancelled && error.belongsTo(controller.signal));
  assert.deepEqual(facts, [
    { kind: 'started', path: 'cancelled.txt' },
    { kind: 'not-created', path: 'cancelled.txt', reason: 'cancelled' },
  ]);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(files.readText('missing.txt', controller.signal), (error) => error instanceof InvocationCancelled);
});

test('cancellation during staged writing removes the temporary file and reports cancelled', async (t) => {
  const { root, files } = await workspace(t);
  const probe = await open(join(root, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  const write = prototype.writeFile;
  await probe.close();
  await rm(join(root, 'probe'));
  const controller = new AbortController();
  t.mock.method(prototype, 'writeFile', async function (...args) {
    controller.abort('abort while staging');
    return write.apply(this, args);
  });
  const facts = [];
  await assert.rejects(files.createText('cancelled.txt', 'answer', { signal: controller.signal, progress: channel(facts) }), (error) => error instanceof InvocationCancelled && error.belongsTo(controller.signal));
  assert.deepEqual(facts.at(-1), { kind: 'not-created', path: 'cancelled.txt', reason: 'cancelled' });
  assert.deepEqual(await readdir(root), []);
});

test('cancellation and a failed passive receiver after publication cannot retract or repeat the file', async (t) => {
  const { root, files } = await workspace(t);
  const controller = new AbortController();
  const facts = [];
  const progress = channel(facts, (fact) => {
    if (fact.kind === 'created') {
      controller.abort('stop after write');
      throw new Error('feedback unavailable');
    }
  });
  const receipt = await files.createText('created.txt', 'answer', { signal: controller.signal, progress });
  assert.equal(receipt.path, 'created.txt');
  assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'answer');
  assert.equal(progress.failure.error.message, 'feedback unavailable');
  assert.deepEqual(
    facts.map((fact) => fact.kind),
    ['started', 'created'],
  );
  assert.deepEqual(await readdir(root), ['created.txt']);
});

test('uncertain publication failure reports unconfirmed and never rolls back a possibly created target', async (t) => {
  const { root, files } = await workspace(t);
  const originalLink = filesystem.link;
  const patched = t.mock.method(filesystem, 'link', async (...args) => {
    await originalLink(...args);
    throw Object.assign(new Error('filesystem did not confirm publication'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  try {
    const facts = [];
    await assert.rejects(files.createText('uncertain.txt', 'answer', { progress: channel(facts) }), isFailure('io'));
    assert.equal(await readFile(join(root, 'uncertain.txt'), 'utf8'), 'answer');
    assert.deepEqual(facts, [
      { kind: 'started', path: 'uncertain.txt' },
      { kind: 'unconfirmed', path: 'uncertain.txt' },
    ]);
    assert.deepEqual(await readdir(root), ['uncertain.txt']);
  } finally {
    patched.mock.restore();
    syncBuiltinESMExports();
  }
});

function resourceBinding(files, task, progress, observation) {
  const requests = { reader: FileResources.readText.request(), creator: FileResources.createText.request() };
  const parent = bindResources(requests, [FileResources.readText.provide((source) => source), FileResources.createText.provide((source) => source)])({ files, constraint: task, progress });
  const bound = parent.select(requests, requests, { input: task, refinements: [FileResources.readText.refine((input) => input.sourcePath), FileResources.createText.refine((input) => input.output.path)] });
  let active = true;
  bound.attach({
    contextId: 'file-call',
    validate() {
      if (!active) throw new Error('Call closed');
    },
    observation,
  });
  bound.start();
  return {
    bound,
    close() {
      active = false;
    },
  };
}

test('resource endpoints restrict exact task paths and observation contains only descriptors', async (t) => {
  const { root, files } = await workspace(t);
  await writeFile(join(root, 'input.txt'), 'private source text');
  const observations = [];
  const scope = resourceBinding(files, { sourcePath: 'input.txt', output: { path: 'output.txt' } }, undefined, {
    publish(fact) {
      observations.push(fact.describe());
    },
  });
  const reader = scope.bound.values.reader;
  const creator = scope.bound.values.creator;
  assert.equal((await reader.readText('input.txt')).text, 'private source text');
  await assert.rejects(reader.readText('another.txt'), isFailure('not-allowed'));
  await assert.rejects(creator.createText('other.txt', 'generated'), isFailure('not-allowed'));
  await creator.createText('output.txt', 'private generated text');
  assert.ok(!JSON.stringify(observations).includes('private source text'));
  assert.ok(!JSON.stringify(observations).includes('private generated text'));
  scope.close();
  await assert.rejects(reader.readText('input.txt'), /Call closed/);
  await assert.rejects(creator.createText('output.txt', 'later'), /Call closed/);
});

test('returned resource observation may fail after publication without changing the producer receipt', async (t) => {
  const { root, files } = await workspace(t);
  const facts = [];
  const failure = new Error('record consumer failed');
  const scope = resourceBinding(files, { sourcePath: 'input.txt', output: { path: 'output.txt' } }, channel(facts), {
    publish(fact) {
      if (fact.phase === 'returned') return failure;
    },
  });
  await assert.rejects(scope.bound.values.creator.createText('output.txt', 'answer'), (error) => error === failure);
  assert.equal(await readFile(join(root, 'output.txt'), 'utf8'), 'answer');
  assert.deepEqual(
    facts.map((fact) => fact.kind),
    ['started', 'created'],
  );
});
