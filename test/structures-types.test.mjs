import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Runner, Resources, Group, Node, Scene } from '@weiliang0121/capix-runtime';

const entry = fileURLToPath(new URL('./types/structures.ts', import.meta.url));
const source = readFileSync(entry, 'utf8');
const options = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  noUncheckedIndexedAccess: true,
  verbatimModuleSyntax: true,
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

test('structure configuration retains I/O, resources, member operations and checkpoint ownership', () => {
  const errors = diagnostics(source);
  assert.equal(errors.length, 0, format(errors));
});

test('structure author contract counterexamples fail at their own call sites', () => {
  const errors = diagnostics(source.replaceAll('@ts-expect-error', 'expected compile error'));
  const count = source.match(/@ts-expect-error/g)?.length ?? 0;
  assert.equal(errors.length, count, format(errors));
  assert.ok(
    errors.every((error) => error.file?.fileName === entry),
    format(errors),
  );
});

test('a processing callback cannot call a member outside its actual registration', async () => {
  let called = 0;
  const child = new Node({ run: () => ++called });
  const scene = new Scene({ run: (work) => work.children.invoke(child, null) });
  const runner = new Runner(scene, new Resources()).build();
  await assert.rejects(runner.run(null), /not declared|not registered/);
  assert.equal(called, 0);
  assert.equal(runner.isRunning, false);
});

test('legacy phase configuration is rejected rather than silently installed', () => {
  for (const field of ['accept', 'exceptions', 'raises', 'maxRounds', 'uses', 'observation', 'callee']) {
    assert.throws(() => new Node({ run: () => null, [field]: [] }), new RegExp(`Unsupported callable configuration field: ${field}`));
  }
});
