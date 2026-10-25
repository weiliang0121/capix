import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as structures from '@capix/structure';
import * as runtime from '@capix/server-runtime';
import * as contracts from '@capix/contracts';

test('input preparation has no entry object or unnamed child entry port', async () => {
  for (const exports of [structures, runtime, contracts]) {
    assert.equal('InvocationEntry' in exports, false);
    assert.equal('defineChildEntry' in exports, false);
  }
  const child = new structures.Node({ run: (work) => work.input });
  const scene = new structures.Scene().add(child);
  scene.run = (work) => {
    assert.equal(work.children.entry, undefined);
    const input = String(work.input);
    return work.children.invoke(child, input);
  };
  assert.equal(await new runtime.Runner(scene, new runtime.Resources()).build().run(42), '42');
});

test('entry is available as an ordinary named member after removing the special port', async () => {
  const entry = new structures.Node({ run: (work) => `received:${work.input}` });
  const group = new structures.Group().add({ entry });
  group.run = (work) => work.children.entry.invoke(work.input);
  const scene = new structures.Scene().add({ group });
  scene.run = (work) => work.children.group.invoke(work.input);
  assert.equal(group.names.entry, entry);
  assert.equal(await new runtime.Runner(scene, new runtime.Resources()).build().run('hello'), 'received:hello');
});

test('the deleted entry exports and port are rejected while named entry members retain their I/O', () => {
  const file = fileURLToPath(new URL('./types/entry-removal-probe.ts', import.meta.url));
  const source = `
import { Node, Group } from '@capix/structure';
import type { ChildCalls } from '@capix/contracts';
// @ts-expect-error the structure package no longer exports the entry factory
import { defineChildEntry } from '@capix/structure';
// @ts-expect-error the runtime package no longer exports the entry class
import { InvocationEntry } from '@capix/server-runtime';
// @ts-expect-error the contracts package no longer contains the old entry contract
import type { ChildEntry } from '@capix/contracts';
// @ts-expect-error the old adapter input envelope is removed
import type { ChildEntryInput } from '@capix/server-runtime';
// @ts-expect-error the old adapter facts are removed
import type { ChildEntryFacts } from '@capix/structure';
declare const calls: ChildCalls;
// @ts-expect-error ordinary child access has no entry method
calls.entry;
const entry = new Node<string, number>({ run: work => work.input.length });
const parent = new Group<string, number>().add({ entry });
parent.run = work => {
  const result: Promise<number> = work.children.entry.invoke(work.input);
  // @ts-expect-error the newly available member name retains its actual input contract
  work.children.entry.invoke(42);
  return result;
};
`;
  const options = { strict: true, noEmit: true, skipLibCheck: false, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  function diagnostics(text) {
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (path, languageVersion, onError, fresh) => (path === file ? ts.createSourceFile(path, text, languageVersion, true) : original(path, languageVersion, onError, fresh));
    return ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
  }
  const format = (errors) => ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (path) => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
  const accepted = diagnostics(source);
  assert.equal(accepted.length, 0, format(accepted));
  const lines = source.split('\n');
  const expected = lines.flatMap((line, index) => (line.includes('@ts-expect-error') ? [index + 1] : []));
  const rejected = diagnostics(lines.map((line) => (line.includes('@ts-expect-error') ? '' : line)).join('\n'));
  assert.ok(
    rejected.every((error) => error.file?.fileName === file),
    format(rejected),
  );
  assert.deepEqual([...new Set(rejected.map((error) => error.file.getLineAndCharacterOfPosition(error.start).line))], expected, format(rejected));
});
