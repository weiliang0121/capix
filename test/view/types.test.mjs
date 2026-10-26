import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('view sources retain their key and value types through indexing, selection and resource access', async () => {
  const entry = fileURLToPath(new URL('./types.ts', import.meta.url));
  const source = await readFile(entry, 'utf8');
  const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, types: ['node'], target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const diagnostics = (text) => {
    const host = ts.createCompilerHost(options);
    const readSource = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (file === entry ? ts.createSourceFile(file, text, languageVersion, true) : readSource(file, languageVersion, onError, shouldCreateNewSourceFile));
    return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
  };
  const format = (errors) => ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
  const accepted = diagnostics(source);
  assert.equal(accepted.length, 0, format(accepted));
  const expected = source.match(/@ts-expect-error/g)?.length ?? 0;
  assert.ok(expected > 0, 'the fixture must exercise rejected boundary values');
  const rejected = diagnostics(source.replaceAll('@ts-expect-error', 'expected compile error'));
  assert.equal(rejected.length, expected, format(rejected));
  assert.ok(
    rejected.every((error) => error.file?.fileName === entry),
    format(rejected),
  );
});
