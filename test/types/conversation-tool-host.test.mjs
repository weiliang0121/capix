import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('tool host preserves entry use, provider inspection and child input types', () => {
  const program = ts.createProgram([fileURLToPath(new URL('./conversation-tool-host.ts', import.meta.url))], { strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
});
