import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

const interactionDirectory = resolve(root, 'packages/interaction');

const dependencies = ['@weiliang0121/capix-contracts', '@weiliang0121/capix-changes', '@weiliang0121/capix-diagnostics', 'es-toolkit'];

const excludedPackages = ['@weiliang0121/capix-runtime', '@weiliang0121/capix-invocation', '@weiliang0121/capix-structure', '@weiliang0121/capix-resources'];

const excludedDirectories = ['packages/runtime', 'packages/invocation', 'packages/structure', 'packages/resources'];

test('interaction package exposes external exchanges with only lower dependencies', async () => {
  const manifest = JSON.parse(await readFile(resolve(interactionDirectory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@weiliang0121/capix-interaction');
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
          if (specifier.startsWith('.')) assert.ok(!relative(interactionDirectory, resolve(dirname(file), specifier)).startsWith('..'), `${file} crosses its package boundary`);
        }
      }
    }
  }
  await inspect(resolve(interactionDirectory, 'src'));
  await inspect(resolve(interactionDirectory, 'dist'));
  const interaction = await import('@weiliang0121/capix-interaction');
  for (const name of ['Interaction', 'Interactions']) assert.equal(typeof interaction[name], 'function');
  for (const name of ['Runner', 'Scene', 'Group', 'Node', 'Invocation', 'CallableContext', 'Resource', 'Resources', 'Recorder', 'CheckpointStore']) assert.equal(name in interaction, false, `${name} does not belong to the interaction package`);
  for (const specifier of ['@weiliang0121/capix-interaction/interaction', '@weiliang0121/capix-interaction/src/interaction.js', '@weiliang0121/capix-interaction/dist/interaction.js']) await assert.rejects(import(specifier), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('interaction builds declarations and runs a typed consumer without Runtime, Invocation, Structure or Resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-interaction-package-'));
  try {
    const packageDirectory = resolve(directory, 'node_modules/@weiliang0121/capix-interaction');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(resolve(packageDirectory, 'package.json'), await readFile(resolve(interactionDirectory, 'package.json')));
    await mkdir(resolve(directory, 'src'));
    await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: 'capix-interaction-consumer', private: true, type: 'module' }));
    for (const dependency of [...dependencies, '@types/node']) {
      const destination = resolve(directory, 'node_modules', dependency);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(await realpath(resolve(dependency === '@types/node' ? root : interactionDirectory, 'node_modules', dependency)), destination, 'dir');
    }
    const excludedRoots = await Promise.all(excludedDirectories.map((path) => realpath(resolve(root, path))));
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
    };
    async function compile(entry, compilerOptions) {
      const program = ts.createProgram([entry], compilerOptions);
      const diagnostics = ts.getPreEmitDiagnostics(program);
      assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => directory, getCanonicalFileName: (file) => file, getNewLine: () => '\n' }));
      for (const source of program.getSourceFiles()) {
        const path = await realpath(source.fileName);
        assert.ok(!excludedRoots.some((excluded) => path === excluded || path.startsWith(`${excluded}${sep}`)), `Interaction compilation loaded an excluded package: ${path}`);
      }
      assert.equal(program.emit().emitSkipped, false);
    }
    // Compile the actual package source into fresh artifacts before consuming its
    // public exports. Existing workspace dist files cannot hide a missing source.
    await compile(resolve(interactionDirectory, 'src/index.ts'), { ...options, rootDir: resolve(interactionDirectory, 'src'), outDir: resolve(packageDirectory, 'dist') });
    assert.match(await readFile(resolve(packageDirectory, 'dist/index.d.ts'), 'utf8'), /Interaction/);
    const fixture = resolve(directory, 'src/verify.ts');
    await writeFile(
      fixture,
      `import assert from 'node:assert/strict';
import { Interaction, Interactions, type InteractionContract, type InteractionState } from '@weiliang0121/capix-interaction';
type Reply = { text: string };
const contract: InteractionContract<string, Reply> = {
  key: 'standalone.echo.v1',
  request(value) {
    if (typeof value !== 'string') throw new TypeError('Invalid request');
    return value;
  },
  reply(value) {
    if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') throw new TypeError('Invalid reply');
    return { text: value.text };
  },
};
const stored = new Map<string, InteractionState<string, Reply>>();
const persistence = {
  create(state: InteractionState<string, Reply>): undefined { stored.set(state.id, structuredClone(state)); },
  commit(change: { expectedRevision: number; state: InteractionState<string, Reply> }): undefined {
    assert.equal(stored.get(change.state.id)?.revision, change.expectedRevision);
    stored.set(change.state.id, structuredClone(change.state));
  },
  read(id: string) { return stored.get(id); },
};
let sends = 0;
const exchanges = new Interactions().register(contract, {
  send(request) { sends++; return { text: request + ':reply' }; },
  persistence,
});
const channel = exchanges.bind(contract);
if (false) {
  // @ts-expect-error The contract keeps its request type at the channel boundary.
  channel.start(7);
}
const ref = channel.start('fixed');
await exchanges.settled();
const received = await channel.wait(ref, { waitMs: 0 });
assert.equal(received.kind, 'received');
if (received.kind !== 'received') throw new Error('Expected feedback');
const text: string = received.feedback.payload.text;
const repeated = channel.read(ref);
assert.equal(repeated.kind, 'received');
if (repeated.kind !== 'received') throw new Error('Expected retained feedback');
assert.equal(repeated.feedback, received.feedback);
exchanges.close();
const restoredHost = new Interactions().register(contract, { send: () => assert.fail('restoration cannot send'), persistence });
const restored = restoredHost.bind(contract).read(ref);
assert.equal(restored.kind, 'received');
if (restored.kind !== 'received') throw new Error('Expected saved feedback');
const saved = stored.get(ref.id);
assert.ok(saved);
const restoredEntity = Interaction.restore(saved, { contract });
assert.equal(restoredEntity.id, ref.id);
assert.throws(() => restoredEntity.start(() => ({ text: 'resent' })), { code: 'INTERACTION_RESTORED' });
restoredHost.close();
console.log(JSON.stringify({ text, restored: restored.feedback.payload.text, sends, revisions: saved.revision }));
`,
    );
    await compile(fixture, { ...options, rootDir: resolve(directory, 'src'), outDir: resolve(directory, 'dist') });
    assert.match(await readFile(resolve(directory, 'dist/verify.d.ts'), 'utf8'), /export/);
    const forbidden = resolve(directory, 'src/forbidden.ts');
    await writeFile(forbidden, excludedPackages.map((name, index) => `import * as excluded${index} from '${name}'; void excluded${index};`).join('\n'));
    const rejected = ts.getPreEmitDiagnostics(ts.createProgram([forbidden], { ...options, noEmit: true }));
    assert.equal(rejected.filter((diagnostic) => diagnostic.code === 2307).length, excludedPackages.length, rejected.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
    // Lower dependencies are symlinked to their real packages. Guard every loaded
    // path so an accidental transitive import cannot borrow the workspace runtime.
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
    if (excludedRoots.some(excluded => path === excluded || path.startsWith(excluded + sep))) {
      throw Object.assign(new Error('Interaction boundary excludes ' + path), { code: 'ERR_INTERACTION_BOUNDARY' });
    }
  }
  return resolved;
} });
`,
    );
    for (const excluded of excludedRoots) {
      const probe = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(resolve(excluded, 'dist/index.js')).href)});`], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
      assert.notEqual(probe.status, 0);
      assert.match(probe.stderr, /ERR_INTERACTION_BOUNDARY/);
    }
    const child = spawnSync(process.execPath, ['--import', guard, resolve(directory, 'dist/verify.js')], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { text: 'fixed:reply', restored: 'fixed:reply', sends: 1, revisions: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
