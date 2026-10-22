import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Driver, Group, Node, ExceptionContract } from '@capix/server-runtime';

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

test('structure constructors and phase setters retain I/O, requests, actions and checkpoint ownership', () => {
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

test('an explicitly annotated callback cannot enlarge the installed phase action grant', async () => {
  let childCalls = 0;
  const child = new Node({
    run: {
      execute: () => {
        childCalls++;
        return 'unreachable';
      },
    },
  });
  const group = new Group();
  group.add(child);
  // TypeScript annotations are erased; actual authority comes from uses.
  group.setRun({ uses: [], execute: (work) => work.children.create(child, null).run() });
  const driver = new Driver();
  const bound = driver.build(group, { providers: [], source: { capture: () => null } });
  await assert.rejects(driver.run(bound, null, {}), /not declared.*phase uses/);
  assert.equal(childCalls, 0);
  assert.equal(driver.isRunning(bound), false);
});

test('constructor exception configuration grants no actions when uses is omitted', async () => {
  const failure = new ExceptionContract('structures.failure');
  let childCalls = 0;
  const child = new Node({
    run: {
      execute: () => {
        childCalls++;
        return 'unreachable';
      },
    },
  });
  const group = new Group({
    raises: [failure],
    run: {
      execute: () => {
        throw failure.create('enter exception handler', null);
      },
    },
    exceptions: {
      accepts: [failure],
      handle: (work) => work.children.create(child, null).run(),
    },
  }).add(child);
  const driver = new Driver();
  const bound = driver.build(group, { providers: [], source: { capture: () => null } });
  await assert.rejects(driver.run(bound, null, {}), /not declared.*phase uses/);
  assert.equal(childCalls, 0);
  assert.equal(driver.isRunning(bound), false);
});
