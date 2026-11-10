import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Group, Node, Scene, withDependencies } from '@weiliang0121/capix-structure';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('common requests are copied before authoring and cannot override local aliases or alter existing nodes', () => {
  const flow = new ResourceOffer({ methods: { read: (origin) => origin.value } });
  const other = new ResourceOffer({ methods: { read: (origin) => origin } });
  const request = flow.request();
  const requests = { flow: request };
  const factory = withDependencies(requests);
  requests.flow = other.request();
  const existing = new Node({ run: () => 'existing' });
  const options = {
    deps: { local: other.request() },
    run() {
      return this === options;
    },
  };
  const child = factory.node()(options);
  assert.equal(child.deps.flow, request);
  assert.equal(child.deps.local, options.deps.local);
  assert.equal(child.run(), true, 'the author callback retains its configuration receiver');
  assert.equal(existing.deps?.flow, undefined, 'the helper cannot inject requests into already created structures');
  assert.throws(() => factory.node()({ deps: { flow: request }, run: () => null }), /Duplicate common dependency alias/);
  assert.throws(() => factory.group()({ deps: { flow: other.request() }, run: () => null }), /Duplicate common dependency alias/);
  assert.throws(() => withDependencies({ flow: {} }), /resource requests/);

  const first = factory.group()({ members: [child], run: () => null });
  assert.ok(first instanceof Group);
  assert.throws(() => factory.group()({ members: [child], run: () => null }), /parent|registered|belong|attached/i, 'common requests do not make structure instances shareable');
  assert.ok(factory.scene()({ run: () => null }) instanceof Scene);
});

test('common dependency types preserve local inference, child signatures and explicit checkpoint resource windows', async () => {
  const entry = fileURLToPath(new URL('./types/common-dependencies.ts', import.meta.url));
  const source = await readFile(entry, 'utf8');
  const options = { strict: true, noEmit: true, noUncheckedIndexedAccess: true, skipLibCheck: false, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  function diagnostics(text) {
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, create) => (file === entry ? ts.createSourceFile(file, text, languageVersion, true) : getSourceFile(file, languageVersion, onError, create));
    return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
  }
  const format = (errors) => ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
  const accepted = diagnostics(source);
  assert.equal(accepted.length, 0, format(accepted));
  const lines = source.split('\n');
  const expected = lines.flatMap((line, index) => (line.includes('@ts-expect-error') ? [index + 1] : []));
  const rejected = diagnostics(lines.map((line) => (line.includes('@ts-expect-error') ? '' : line)).join('\n'));
  assert.ok(
    rejected.every((error) => error.file?.fileName === entry),
    format(rejected),
  );
  assert.deepEqual([...new Set(rejected.map((error) => error.file.getLineAndCharacterOfPosition(error.start).line))], expected, format(rejected));
});
