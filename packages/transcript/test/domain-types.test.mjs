import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('Transcript owns fixed message, locator, snapshot and event public types', async () => {
  const entry = fileURLToPath(new URL('./domain.types.ts', import.meta.url));
  const source = await readFile(entry, 'utf8');
  const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
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
  assert.deepEqual([...new Set(rejected.map((error) => error.file.getLineAndCharacterOfPosition(error.start).line))], expected, format(rejected));
});
