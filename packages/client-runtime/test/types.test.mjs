import assert from 'node:assert/strict';

import { test } from 'node:test';

import { fileURLToPath } from 'node:url';

import ts from 'typescript';

test('public submission acceptance callbacks require synchronous undefined notifications', () => {
  const program = ts.createProgram([fileURLToPath(new URL('./submission.types.ts', import.meta.url))], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
});
