import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as structures from '@weiliang0121/capix-structure';
import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';

test('structure authors can configure a complete tree without loading or executing a runtime', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { Scene, Group, Node, defineNode } from '@weiliang0121/capix-structure';
    let calls = 0;
    const leaf = defineNode()({ run: () => ++calls });
    const group = new Group().add({ leaf });
    group.run = work => work.children.leaf.invoke(work.input);
    const scene = new Scene().add({ group });
    scene.run = work => work.children.group.invoke(work.input);
    assert.ok(leaf instanceof Node);
    assert.equal(scene.names.group, group);
    assert.equal(group.members[0], leaf);
    assert.equal(calls, 0);
    assert.throws(() => new Group().add(leaf), /parent/);
    assert.throws(() => group.add(group), /Cyclic/);
  `,
    ],
    { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  for (const name of ['Runner', 'Resources', 'Invocation', 'CallableBuilder', 'MemoryCheckpointStore', 'Recorder', 'Transcript']) assert.equal(name in structures, false, `${name} is not a structural author contract`);
});

test('structure declarations have no reverse runtime dependency or private cross-package imports', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@weiliang0121/capix-contracts', '@weiliang0121/capix-resources']);
  assert.equal(manifest.peerDependencies?.['@weiliang0121/capix-runtime'], undefined);
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await inspect(child);
      else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.js')) {
        const content = await readFile(child, 'utf8');
        assert.doesNotMatch(content, /@weiliang0121\/capix-runtime|(?:\.\.\/)+runtime\/|(?:@capix\/|@weiliang0121\/capix-)[\w-]+\/(?:src|dist)\//, fileURLToPath(child));
      }
    }
  }
  await inspect(new URL('dist/', root));
});

test('standalone structure types preserve named children, resources, output and recovery associations', async () => {
  const entry = fileURLToPath(new URL('./types/structure-package.ts', import.meta.url));
  const source = await readFile(entry, 'utf8');
  const options = { strict: true, noEmit: true, noUncheckedIndexedAccess: true, skipLibCheck: false, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const diagnostics = (text) => {
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (file === entry ? ts.createSourceFile(file, text, languageVersion, true) : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile));
    return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
  };
  const format = (errors) => ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
  const accepted = diagnostics(source);
  assert.equal(accepted.length, 0, format(accepted));
  const lines = source.split('\n');
  const expected = lines.flatMap((line, index) => (line.includes('@ts-expect-error') ? [index + 1] : []));
  const rejected = diagnostics(lines.map((line) => (line.includes('@ts-expect-error') ? '' : line)).join('\n'));
  assert.ok(
    rejected.every((error) => error.file?.fileName === entry),
    format(rejected),
  );
  const actual = [...new Set(rejected.map((error) => error.file.getLineAndCharacterOfPosition(error.start).line))];
  assert.deepEqual(actual, expected, format(rejected));
});
