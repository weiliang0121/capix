import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('production tool registration retains exact member IO and explicit policies', () => {
  const program = ts.createProgram([fileURLToPath(new URL('./conversation-tools.ts', import.meta.url))], { strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
});
