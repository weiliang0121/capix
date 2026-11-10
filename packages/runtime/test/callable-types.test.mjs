import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const entry = fileURLToPath(new URL('./types/callable-bindings.ts', import.meta.url));
const source = readFileSync(entry, 'utf8');
const options = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

function diagnostics(text) {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (file === entry ? ts.createSourceFile(file, text, languageVersion, true) : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile));
  return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
}

function format(errors) {
  return ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
}

test('Driver preserves each built structure, input, output and required options', () => {
  const errors = diagnostics(source);
  assert.equal(errors.length, 0, format(errors));
});

test('unbuilt, mismatched and widened assembly contracts fail at author call sites', () => {
  const errors = diagnostics(source.replaceAll('@ts-expect-error', 'expected compile error'));
  assert.equal(errors.length, source.match(/@ts-expect-error/g)?.length ?? 0, format(errors));
  assert.ok(
    errors.every((error) => error.file?.fileName === entry),
    format(errors),
  );
});
