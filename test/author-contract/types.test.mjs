import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };

test('production author factories preserve the same phase, resource and checkpoint type boundaries', () => {
  const program = ts.createProgram([fileURLToPath(new URL('./types/production.ts', import.meta.url))], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
});

for (const [file, codes] of [
  ['rejected-point-owner.ts', [2322, 2769]],
  ['rejected-child-call.ts', [2345, 2345]],
  ['rejected-result.ts', [2769]],
]) {
  test(`author contract rejects ${file} without suppression directives`, () => {
    const entry = fileURLToPath(new URL(`./types/${file}`, import.meta.url));
    const program = ts.createProgram([entry], options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      codes,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (name) => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }),
    );
    assert.ok(
      diagnostics.every((diagnostic) => diagnostic.file?.fileName === entry),
      'negative fixture must fail at the author usage, not in the production declarations',
    );
  });
}
