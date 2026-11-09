import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

test('checkpoint values and storage expose independent value and storage-adapter entries without running-host dependencies', async () => {
  const directory = fileURLToPath(new URL('../server/checkpoint/', import.meta.url));
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@weiliang0121/capix-checkpoint');
  assert.deepEqual(Object.keys(manifest.exports), ['.', './storage']);
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
  assert.deepEqual(
    dependencies.filter((name) => name.startsWith('@capix/') || name.startsWith('@weiliang0121/capix-')),
    ['@weiliang0121/capix-contracts'],
  );
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (/\.(?:ts|js)$/.test(entry.name)) {
        const source = await readFile(file, 'utf8');
        for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
          const specifier = match[2];
          if (specifier.startsWith('@capix/') || specifier.startsWith('@weiliang0121/capix-')) assert.equal(specifier, '@weiliang0121/capix-contracts', `${file} cannot import ${specifier}`);
          if (specifier.startsWith('.')) assert.ok(!relative(directory, resolve(dirname(file), specifier)).startsWith('..'), `${file} crosses its package boundary`);
        }
      }
    }
  }
  await inspect(resolve(directory, 'src'));
  await inspect(resolve(directory, 'dist'));
  const checkpoint = await import('@weiliang0121/capix-checkpoint');
  const runtime = await import('@weiliang0121/capix-runtime');
  for (const name of ['MemoryCheckpointStore', 'cloneCheckpointValue', 'cloneCheckpointImage', 'cloneCheckpointHead', 'cloneCheckpointDelivery', 'checkpointReference', 'checkpointReferenceChild', 'CHECKPOINT_MAX_BYTES']) {
    assert.ok(name in checkpoint);
    assert.equal(name in runtime, false);
  }
  for (const name of ['Runner', 'Invocation', 'InvocationCheckpoint', 'Scene', 'Node', 'checkpointPoint', 'Resources', 'Recorder']) assert.equal(name in checkpoint, false);
  for (const path of ['@weiliang0121/capix-checkpoint/store', '@weiliang0121/capix-checkpoint/src/store.js', '@weiliang0121/capix-checkpoint/dist/store.js']) await assert.rejects(import(path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('a host can use checkpoint storage and shared diagnostics without loading a scene or runtime', () => {
  const script = `
    import { MemoryCheckpointStore, cloneCheckpointHead } from '@weiliang0121/capix-checkpoint';
    import { RuntimeError } from '@weiliang0121/capix-contracts';
    const store = new MemoryCheckpointStore();
    const saved = store.save({
      id: 'snapshot', formatVersion: 6, contract: { key: 'standalone', version: 1 }, point: 'prepared',
      frame: { owner: { contextId: 'call', kind: 'node' }, round: 1, phase: 'execute', input: 'input', currentInput: 'input', nextChildOrder: 0, children: [] },
      state: { text: 'prepared' }, references: {},
    }, 0);
    const returned = store.finish('call', saved.revision, { status: 'succeeded', output: 'result', progress: { round: 1, phase: 'execute', currentInput: 'input' } });
    const read = cloneCheckpointHead(JSON.parse(JSON.stringify(store.read('call'))));
    let fixed = false;
    try { store.finish('call', returned.revision, { status: 'failed' }); }
    catch (error) { fixed = error instanceof RuntimeError && error.code === 'CHECKPOINT_CONFLICT'; }
    process.stdout.write(JSON.stringify({ state: read.image.state, delivery: read.delivery, revision: read.revision, fixed }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    state: { text: 'prepared' },
    delivery: { status: 'succeeded', output: 'result', progress: { round: 1, phase: 'execute', currentInput: 'input' } },
    revision: 2,
    fixed: true,
  });
});

test('checkpoint types share call identity and keep live installation and restoration ports in runtime', () => {
  const program = ts.createProgram([fileURLToPath(new URL('./types/checkpoint-package.ts', import.meta.url))], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
});
