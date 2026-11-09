import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as contracts from '@weiliang0121/capix-contracts';
import { callableKinds as wireKinds } from '@weiliang0121/capix-protocol';

test('contracts own shared vocabulary without a reverse implementation or wire dependency', async () => {
  assert.equal(contracts.callableKinds, wireKinds);
  assert.deepEqual(Object.keys(contracts).sort(), ['RuntimeError', 'StableValueError', 'callableKinds', 'stableValue', 'stableValueLimits']);
  const root = new URL('../contracts/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), []);
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await inspect(child);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
        const content = await readFile(child, 'utf8');
        assert.doesNotMatch(content, /(?:from|import)\s*[(]?\s*['"](?:@capix\/|@weiliang0121\/capix-|node:|(?:\.\.\/)+(?:server|protocol)\/)/, fileURLToPath(child));
      }
    }
  }
  await inspect(new URL('src/', root));
  await inspect(new URL('dist/', root));
});

test('shared contracts preserve callable invariance, reception results and checkpoint references', async () => {
  const entry = fileURLToPath(new URL('./types/contracts-package.ts', import.meta.url));
  const source = await readFile(entry, 'utf8');
  const options = { strict: true, noEmit: true, noUncheckedIndexedAccess: true, skipLibCheck: false, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const diagnostics = (text) => {
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, version, onError, fresh) => (file === entry ? ts.createSourceFile(file, text, version, true) : getSourceFile(file, version, onError, fresh));
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
