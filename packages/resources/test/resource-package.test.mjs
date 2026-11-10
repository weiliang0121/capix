import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as resourcesPackage from '@weiliang0121/capix-resources';
import { Resource, ResourceOffer, Resources } from '@weiliang0121/capix-resources';
import { receiveOperation } from '@weiliang0121/capix-resources/operation';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';

// This consumer intentionally imports no runtime. Its host owns access lifetime
// and identifies its own protected failures; no Scene or Invocation is needed.
class HostFailure extends Error {}

const failures = {
  isProtected: (error) => error instanceof HostFailure,
  isCancellation: () => false,
  describe: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
};

test('resources can supply controlled operations without loading the callable runtime', async () => {
  const value = { text: 'retained by reference' };
  const resource = new Resource(new Map([['word', value]]));
  const offer = new ResourceOffer({
    methods: {
      read(origin, key, operation) {
        operation.emit(key);
        if (!origin.has(key)) throw new Error('missing');
        return origin.get(key);
      },
    },
  });
  const binding = new Resources().register(resource, offer).bind({ dictionary: offer.request() });
  let active = true;
  const access = binding.open({
    contextId: 'independent-host',
    failures,
    validate: () => {
      if (!active) throw new HostFailure('closed');
    },
  });
  const endpoint = access.endpoints.dictionary;
  const deltas = [];
  assert.equal(await endpoint.read('word', { delta: (value) => deltas.push(value) }), value);
  assert.deepEqual(deltas, ['word']);
  assert.equal(await endpoint.read('absent', { result: { failed: () => 'fallback' } }), 'fallback');
  assert.equal(await receiveOperation({ status: 'succeeded', value }), value);
  active = false;
  let handled = false;
  await assert.rejects(
    endpoint.read('word', {
      result: {
        failed: () => {
          handled = true;
        },
      },
    }),
    HostFailure,
  );
  assert.equal(handled, false);
  for (const name of ['Runner', 'Scene', 'Node', 'Interactions', 'Invocation', 'Transcript', 'Recorder', 'ResourceBindings', 'bindResources']) assert.equal(name in resourcesPackage, false, `${name} does not belong to the resource mechanism package`);
});

test('resource ownership requires a complete failure policy and failed opening leaves the fixed binding reusable', async () => {
  const protectedFailure = new HostFailure('protected');
  const offer = new ResourceOffer({
    methods: {
      fail: () => {
        throw protectedFailure;
      },
    },
  });
  const binding = new Resources().register(new Resource(null), offer).bind({ resource: offer.request() });
  assert.throws(() => binding.open({ contextId: 'host', validate() {} }), /failure policy/i);
  assert.throws(() => binding.open({ contextId: 'host', failures: { ...failures, isProtected: null }, validate() {} }), /failure policy/i);
  const policy = { ...failures };
  const owned = [];
  const access = binding.open({ contextId: 'host', failures: policy, validate() {}, error: (failure) => owned.push(failure) });
  // The policy is a fixed host contract, not a mutable lookup during each use.
  policy.isProtected = () => false;
  let received = false;
  await assert.rejects(
    access.endpoints.resource.fail(undefined, {
      result: {
        failed: () => {
          received = true;
          return 'masked';
        },
      },
    }),
    (error) => error === protectedFailure,
  );
  assert.equal(received, false);
  assert.ok(owned.includes(protectedFailure));
});

test('a broken host failure classifier preserves both faults and never enters business reception', async () => {
  for (const mode of ['throws', 'non-boolean']) {
    const operationFailure = new Error('source failed');
    const classificationFailure = new Error('classification failed');
    const offer = new ResourceOffer({
      methods: {
        fail() {
          throw operationFailure;
        },
      },
    });
    const binding = new Resources().register(new Resource(null), offer).bind({ resource: offer.request() });
    const owned = [];
    const access = binding.open({
      contextId: mode,
      failures: {
        ...failures,
        isProtected() {
          if (mode === 'throws') throw classificationFailure;
          return 'false';
        },
      },
      validate() {},
      error: (error) => owned.push(error),
    });
    let received = false;
    await assert.rejects(
      access.endpoints.resource.fail(undefined, {
        result: {
          failed: () => {
            received = true;
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, operationFailure);
        assert.equal(error.errors[0], operationFailure);
        if (mode === 'throws') assert.equal(error.errors[1], classificationFailure);
        else assert.match(error.errors[1].message, /must return a boolean/);
        assert.ok(owned.includes(error));
        return true;
      },
    );
    assert.equal(received, false);
  }
});

test('async host failure classifiers reject their contract without leaking unhandled rejections', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { Resource, ResourceOffer, Resources } from '@weiliang0121/capix-resources';
    for (const method of ['isProtected', 'isCancellation']) {
      const controller = new AbortController();
      const original = new Error('operation failure');
      const closed = new Error('host closed');
      const offer = new ResourceOffer({ methods: { fail() {
        if (method === 'isCancellation') controller.abort();
        throw original;
      } } });
      const binding = new Resources().register(new Resource(null), offer).bind({ source: offer.request() });
      const policy = { isProtected: () => false, isCancellation: () => false, describe: () => null };
      policy[method] = async () => { throw new Error('invalid async policy'); };
      const owned = [];
      const access = binding.open({ contextId: method, failures: policy, signal: controller.signal,
        validate() { if (controller.signal.aborted) throw closed; },
        error: error => owned.push(error),
      });
          let handled = false;
      await assert.rejects(access.endpoints.source.fail(undefined, { result: { failed() { handled = true; } } }), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, original);
        assert.equal(error.errors[0], original);
        assert.ok(error.errors[1] instanceof TypeError);
        assert.match(error.errors[1].message, /must return a boolean/);
        assert.ok(owned.includes(error));
        return true;
      });
      assert.equal(handled, false);
      await new Promise(resolve => setImmediate(resolve));
    }
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', source], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test('resource package declarations contain no reverse runtime dependency or private cross-package imports', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  for (const name of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]) assert.notEqual(name, '@weiliang0121/capix-runtime');
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await inspect(child);
      else if (entry.name.endsWith('.d.ts')) {
        const content = await readFile(child, 'utf8');
        assert.doesNotMatch(content, /@weiliang0121\/capix-runtime|(?:\.\.\/)+runtime\//, fileURLToPath(child));
      }
    }
  }
  await inspect(new URL('dist/', root));
});

test('standalone resource author types preserve method inputs, result branches and required host policy', async () => {
  const entry = fileURLToPath(new URL('./types/resource-package.ts', import.meta.url));
  const source = await readFile(entry, 'utf8');
  const options = { strict: true, noEmit: true, noUncheckedIndexedAccess: true, skipLibCheck: true, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const diagnostics = (text) => {
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (file === entry ? ts.createSourceFile(file, text, languageVersion, true) : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile));
    return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
  };
  const format = (errors) => ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
  const accepted = diagnostics(source);
  assert.equal(accepted.length, 0, format(accepted));
  const rejected = diagnostics(source.replaceAll('@ts-expect-error', 'expected compile error'));
  assert.equal(rejected.length, source.match(/@ts-expect-error/g)?.length ?? 0, format(rejected));
  assert.ok(
    rejected.every((error) => error.file?.fileName === entry),
    format(rejected),
  );
});
