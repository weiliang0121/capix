import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Driver, Node, defineNode } from '@weiliang0121/capix-runtime';

const entry = fileURLToPath(new URL('./types/flat-configuration.ts', import.meta.url));
const source = readFileSync(entry, 'utf8');
const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
function diagnostics(text) {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (file === entry ? ts.createSourceFile(file, text, languageVersion, true) : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile));
  return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
}
function format(errors) {
  return ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
}

test('flat callable configurations infer resources, member operations, output and checkpoint ownership', () => {
  const errors = diagnostics(source);
  assert.equal(errors.length, 0, format(errors));
});
test('flat callable counterexamples fail at their own author call sites', () => {
  const errors = diagnostics(source.replaceAll('@ts-expect-error', 'expected rejection'));
  assert.equal(errors.length, source.match(/@ts-expect-error/g)?.length ?? 0, format(errors));
  assert.ok(
    errors.every((error) => error.file?.fileName === entry),
    format(errors),
  );
});

const emptyBinding = { providers: [], source: { capture: () => null } };

test('configuration, factory and assigned callbacks keep their specified receivers', async () => {
  const driver = new Driver();
  const configuration = {
    count: 0,
    run(work) {
      this.count++;
      return { input: work.input, count: this.count };
    },
  };
  const node = new Node(configuration);
  const built = driver.build(node, emptyBinding);
  configuration.count = 10;
  configuration.run = () => assert.fail('construction fixes the original callback');
  assert.deepEqual(await driver.run(built, 3, {}), { input: 3, count: 11 });
  assert.equal(configuration.count, 11);

  const setter = new Node();
  setter.prefix = 'structure';
  setter.run = function (work) {
    return `${this.prefix}:${work.input}`;
  };
  assert.equal(await driver.run(driver.build(setter, emptyBinding), 4, {}), 'structure:4');

  const receiver = {
    prefix: 'external',
    run(work) {
      return `${this.prefix}:${work.input}`;
    },
  };
  const explicit = new Node();
  explicit.run = receiver.run.bind(receiver);
  assert.equal(await driver.run(driver.build(explicit, emptyBinding), 5, {}), 'external:5');

  const factoryConfiguration = {
    count: 0,
    run() {
      return ++this.count;
    },
  };
  const factoryNode = defineNode()(factoryConfiguration);
  assert.equal(await driver.run(driver.build(factoryNode, emptyBinding), null, {}), 1);
  assert.equal(factoryConfiguration.count, 1);
});

test('producer result validation receives the fixed successful value', async () => {
  const driver = new Driver();
  const output = { value: 1 };
  const direct = new Node({
    output: {
      result(value) {
        assert.deepEqual(value, output);
        assert.notEqual(value, output);
        assert.ok(Object.isFrozen(value));
        return value;
      },
    },
    run: () => output,
  });
  assert.deepEqual(await driver.run(driver.build(direct, emptyBinding), null, {}), output);
});
