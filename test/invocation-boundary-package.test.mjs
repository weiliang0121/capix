import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const invocationDirectory = resolve(root, 'server/invocation');
const dependencies = ['@weiliang0121/capix-diagnostics', '@weiliang0121/capix-checkpoint', '@weiliang0121/capix-changes', '@weiliang0121/capix-contracts', '@weiliang0121/capix-protocol', '@weiliang0121/capix-resources', 'es-toolkit'];

test('invocation package exposes its call mechanism with only lower dependencies', async () => {
  const manifest = JSON.parse(await readFile(resolve(invocationDirectory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@weiliang0121/capix-invocation');
  assert.deepEqual(Object.keys(manifest.exports), ['.']);
  assert.deepEqual(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).sort(), [...dependencies].sort());
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (/\.(?:ts|js)$/.test(entry.name)) {
        const source = await readFile(file, 'utf8');
        for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
          const specifier = match[2];
          if (specifier.startsWith('@capix/') || specifier.startsWith('@weiliang0121/capix-')) assert.ok(dependencies.includes(specifier), `${file} cannot import ${specifier}`);
          if (specifier.startsWith('.')) assert.ok(!relative(invocationDirectory, resolve(dirname(file), specifier)).startsWith('..'), `${file} crosses its package boundary`);
        }
      }
    }
  }
  await inspect(resolve(invocationDirectory, 'src'));
  await inspect(resolve(invocationDirectory, 'dist'));
  const invocation = await import('@weiliang0121/capix-invocation');
  for (const name of ['Invocation', 'InvocationContext', 'CallableContext', 'InvocationResources', 'InvocationObservation', 'ObserverSession', 'prepareCheckpointRestoration']) assert.equal(typeof invocation[name], 'function');
  for (const name of ['Runner', 'Driver', 'Scene', 'Group', 'Node', 'CallableBinder', 'CallableBuilder', 'CallableInvocationBuilder', 'Resources', 'Interactions', 'Recorder', 'MemoryCheckpointStore']) assert.equal(name in invocation, false, `${name} does not belong to the invocation package`);
  for (const specifier of ['@weiliang0121/capix-invocation/context', '@weiliang0121/capix-invocation/src/invocation/invocation.js', '@weiliang0121/capix-invocation/dist/invocation/invocation.js']) await assert.rejects(import(specifier), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('Runtime compatibility exports preserve invocation and error identities', async () => {
  const invocation = await import('@weiliang0121/capix-invocation');
  const runtime = await import('@weiliang0121/capix-runtime');
  const construction = await import('@weiliang0121/capix-runtime/construction');
  const contracts = await import('@weiliang0121/capix-contracts');
  for (const name of ['Invocation', 'InvocationContext', 'CallableContext', 'InvocationResources', 'invocationResourceFailures', 'inspectChildCallFailure']) {
    assert.ok(name in invocation);
    assert.equal(runtime[name], invocation[name], name);
    assert.equal(construction[name], invocation[name], name);
  }
  for (const name of ['RuntimeError', 'ExceptionContract', 'DeclaredException', 'ChildCallFailure', 'InvocationCancelled', 'ObservationError', 'PersistenceError']) {
    assert.ok(name in invocation);
    assert.equal(runtime[name], invocation[name], name);
  }
  assert.equal(invocation.RuntimeError, contracts.RuntimeError);
  const exception = new invocation.ExceptionContract('BOUNDARY_FAILURE').create('expected failure', { value: 1 });
  assert.ok(exception instanceof runtime.DeclaredException);
  assert.ok(exception instanceof contracts.RuntimeError);
  assert.ok(new runtime.ChildCallFailure(exception) instanceof invocation.ChildCallFailure);
});

test('public invocation types and execution stay independent of Runtime and Structure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-invocation-package-'));
  try {
    // Consume the real package export and declarations, never copied source files.
    await mkdir(resolve(directory, 'src'));
    await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: 'capix-invocation-consumer', private: true, type: 'module' }));
    for (const dependency of ['@weiliang0121/capix-invocation', '@weiliang0121/capix-contracts', '@weiliang0121/capix-checkpoint', '@types/node']) {
      const destination = resolve(directory, 'node_modules', dependency);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(resolve(root, 'node_modules', dependency), destination, 'dir');
    }
    const fixture = resolve(directory, 'src/verify.ts');
    await copyFile(resolve(root, 'test/fixtures/invocation-boundary/verify.ts'), fixture);
    const options = {
      strict: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      skipLibCheck: false,
      noEmitOnError: true,
      declaration: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ['node'],
      typeRoots: [resolve(directory, 'node_modules/@types')],
      rootDir: resolve(directory, 'src'),
      outDir: resolve(directory, 'dist'),
    };
    const program = ts.createProgram([fixture], options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => directory, getCanonicalFileName: (file) => file, getNewLine: () => '\n' }));
    const excludedRoots = await Promise.all(['server/runtime', 'server/structure'].map((path) => realpath(resolve(root, path))));
    for (const source of program.getSourceFiles()) {
      const path = await realpath(source.fileName);
      assert.ok(!excludedRoots.some((excluded) => path === excluded || path.startsWith(`${excluded}${sep}`)), `Invocation declarations loaded an excluded workspace source: ${path}`);
    }
    assert.equal(program.emit().emitSkipped, false);

    const rejectedFixture = resolve(directory, 'src/rejected.ts');
    await copyFile(resolve(root, 'test/fixtures/invocation-boundary/rejected.ts'), rejectedFixture);
    const failures = ts.getPreEmitDiagnostics(ts.createProgram([rejectedFixture], { ...options, noEmit: true }));
    assert.equal(failures.length, 3, failures.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
    assert.ok(failures.every((diagnostic) => diagnostic.code === 2322));
    const failedLines = failures.map((diagnostic) => diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1);
    assert.deepEqual(failedLines, [4, 12, 15]);

    // Neither package is installed for the consumer; importing the new package
    // must not require either of them through its declarations or runtime graph.
    const forbidden = resolve(directory, 'src/forbidden.ts');
    await writeFile(forbidden, "import { Runner } from '@weiliang0121/capix-runtime';\nimport { Scene } from '@weiliang0121/capix-structure';\nvoid Runner; void Scene;\n");
    const rejected = ts.getPreEmitDiagnostics(ts.createProgram([forbidden], { ...options, noEmit: true }));
    assert.equal(rejected.filter((diagnostic) => diagnostic.code === 2307).length, 2, rejected.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));

    // Symlinked dependencies may resolve through their workspace. Inspect every
    // loaded path, and prove the guard rejects deliberate imports of both roots.
    const guard = resolve(directory, 'guard.mjs');
    await writeFile(
      guard,
      `import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
const excludedRoots = ${JSON.stringify(excludedRoots)};
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (resolved.url.startsWith('file:')) {
    const path = realpathSync(fileURLToPath(resolved.url));
    if (excludedRoots.some((excluded) => path === excluded || path.startsWith(excluded + sep))) {
      throw Object.assign(new Error('Invocation boundary excludes ' + path), { code: 'ERR_INVOCATION_BOUNDARY' });
    }
  }
  return resolved;
} });\n`,
    );
    for (const excluded of excludedRoots) {
      const probe = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(resolve(excluded, 'dist/index.js')).href)});`], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
      assert.notEqual(probe.status, 0);
      assert.match(probe.stderr, /ERR_INVOCATION_BOUNDARY/);
    }
    const child = spawnSync(process.execPath, ['--import', guard, resolve(directory, 'dist/verify.js')], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { parentResult: 8, childAccepted: true, observed: true, recoveredResult: 18, checkpointFinished: true, runtimeUnavailable: true, structureUnavailable: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
