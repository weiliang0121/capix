import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('Runtime exposes live checkpoint ports while persistent Frame and Store stay in checkpoint', async () => {
  const checkpoint = await import('@weiliang0121/capix-checkpoint');
  const runtime = await import('@weiliang0121/capix-runtime');
  for (const name of ['MemoryCheckpointStore', 'cloneCheckpointValue', 'cloneCheckpointImage', 'cloneCheckpointHead', 'cloneCheckpointDelivery', 'checkpointReference', 'checkpointReferenceChild', 'CHECKPOINT_MAX_BYTES']) {
    assert.ok(name in checkpoint);
    assert.equal(name in runtime, false);
  }
  const program = ts.createProgram([fileURLToPath(new URL('./types/checkpoint-package.ts', import.meta.url))], { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
});
