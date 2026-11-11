import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const entry = fileURLToPath(new URL('./types/public.ts', import.meta.url));
const source = readFileSync(entry, 'utf8');
const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
function diagnostics(text) {
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (file === entry ? ts.createSourceFile(file, text, languageVersion, true) : original(file, languageVersion, onError, shouldCreateNewSourceFile));
  return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
}
const format = (errors) => ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
test('public Tool inline inference and satisfies preserve member I/O and stable values', () => {
  const errors = diagnostics(source);
  assert.equal(errors.length, 0, format(errors));
});
test('public Tool misuse fails precisely at author call sites', () => {
  const errors = diagnostics(source.replaceAll('@ts-expect-error', 'expected error'));
  assert.equal(errors.length, source.match(/@ts-expect-error/g).length, format(errors));
  assert.ok(
    errors.every((error) => error.file?.fileName === entry),
    format(errors),
  );
});
