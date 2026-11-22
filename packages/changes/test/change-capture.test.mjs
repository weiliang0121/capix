import assert from 'node:assert/strict';

import { test } from 'node:test';

import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { ChangeCaptureError } from '@weiliang0121/capix-changes';

test('ChangeCaptureError keeps its diagnostic name when a bundler renames the class', () => {
  const descriptor = Object.getOwnPropertyDescriptor(ChangeCaptureError, 'name');
  Object.defineProperty(ChangeCaptureError, 'name', { value: 'n' });
  try {
    const event = { type: 'updated' };
    const cause = new Error('capture failed');
    const failure = new ChangeCaptureError(event, cause);
    assert.equal(failure.name, 'ChangeCaptureError');
    assert.equal(failure.event, event);
    assert.equal(failure.cause, cause);
  } finally {
    Object.defineProperty(ChangeCaptureError, 'name', descriptor);
  }
});

test('public capture types allow a shared union observer and reject incompatible source submissions', () => {
  const program = ts.createProgram([fileURLToPath(new URL('./change-capture.ts', import.meta.url))], {
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
