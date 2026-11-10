import assert from 'node:assert/strict';

import { test } from 'node:test';

import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };

for (const [file, codes] of [
  ['started.ts', []],
  ['rejected-started.ts', [2322, 2322]],
]) {
  test(`synchronous invocation setup contract checks ${file}`, () => {
    const entry = fileURLToPath(new URL(`./types/${file}`, import.meta.url));
    const program = ts.createProgram([entry], options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      codes,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (name) => name, getCurrentDirectory: () => fileURLToPath(new URL('../../', import.meta.url)), getNewLine: () => '\n' }),
    );
    assert.ok(
      diagnostics.every((diagnostic) => diagnostic.file?.fileName === entry),
      'invalid setup must fail at the host callback, not in the production declarations',
    );
  });
}
