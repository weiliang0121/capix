import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Resource, ResourceOffer, ResourceRequest, ResourceBinding, ResourceSupply, Resources } from '@weiliang0121/capix-resources';

const policy = Object.freeze({
  isProtected: () => false,
  isCancellation: () => false,
  describe: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
});
const owner = (contextId = 'host') => ({ contextId, failures: policy, validate() {} });

function counterOffer(options = {}) {
  return new ResourceOffer({
    ...options,
    methods: {
      read(value) {
        return value;
      },
    },
  });
}

test('the resource registry binds typed offers, independently of descriptive names', async () => {
  const first = counterOffer({ name: 'same-description' });
  const second = counterOffer({ name: 'same-description' });
  assert.notEqual(first.id, second.id);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(first.request().offer.id, first.id);
  assert.equal('read' in first.request(), false);
  const resources = new Resources().register(new Resource('first'), first).register(new Resource('second'), second);
  const access = resources.bind({ one: first.request(), two: second.request() }).open(owner());
  assert.equal(await access.endpoints.one.read(), 'first');
  assert.equal(await access.endpoints.two.read(), 'second');
  access.close();
});

test('registration and binding reject ambiguity, absent supply, and copied identity tokens', () => {
  const offer = counterOffer();
  const resources = new Resources().register(new Resource(1), offer);
  assert.throws(() => resources.register(new Resource(2), offer), /Duplicate resource registration/);
  assert.throws(() => resources.bind({ absent: counterOffer().request() }), /Expected one resource provider/);
  const copied = new ResourceRequest({ ...offer.request().offer });
  assert.throws(() => resources.bind({ copied }), /Expected one resource provider/);
});

test('binding fixes dependency aliases and providers without reading source material', async () => {
  let captured = 0;
  const offer = counterOffer({
    capture: (source) => {
      captured++;
      return source;
    },
  });
  const dependencies = { original: offer.request() };
  const resources = new Resources().register(new Resource(4), offer);
  const binding = resources.bind(dependencies);
  assert.equal(captured, 0);
  delete dependencies.original;
  dependencies.replaced = counterOffer().request();
  resources.register(new Resource(7), counterOffer());
  const access = binding.open(owner());
  assert.deepEqual(Object.keys(access.endpoints), ['original']);
  assert.equal(await access.endpoints.original.read(), 4);
  assert.equal(captured, 1);
  access.close();
});

test('each registry opening captures once while aliases share the endpoint inside one window', async () => {
  let captures = 0;
  const source = {
    value: 1,
    close() {
      throw new Error('Access must not own the resource');
    },
  };
  const offer = counterOffer({ capture: (value) => ({ sequence: ++captures, value: value.value }) });
  const binding = new Resources().register(new Resource(source), offer).bind({ value: offer.request(), alias: offer.request() });
  const first = binding.open(owner('first'));
  const firstEndpoint = first.endpoints.value;
  assert.equal(firstEndpoint, first.endpoints.alias);
  assert.deepEqual(await firstEndpoint.read(), { sequence: 1, value: 1 });
  first.close();
  source.value = 2;
  const second = binding.open(owner('second'));
  assert.notEqual(firstEndpoint, second.endpoints.value);
  assert.deepEqual(await second.endpoints.value.read(), { sequence: 2, value: 2 });
  assert.equal(captures, 2);
  second.close();
});

test('existing supply shares captured materials across independently closed access windows', async () => {
  let captures = 0;
  const value = { retained: true };
  const offer = counterOffer({
    capture: () => {
      captures++;
      return value;
    },
  });
  const supply = ResourceSupply.capture([offer.provide(() => null)], undefined);
  const binding = ResourceBinding.fromSupply({ value: offer.request() }, supply);
  const first = binding.open(owner('run'));
  const endpoint = first.endpoints.value;
  assert.equal(await endpoint.read(), value);
  first.close();
  const second = binding.open(owner('resume'));
  assert.notEqual(endpoint, second.endpoints.value);
  assert.equal(await second.endpoints.value.read(), value);
  assert.equal(captures, 1);
  await assert.rejects(endpoint.read(), /closed/i);
  second.close();
});

test('supply refinement replaces only the selected material and preserves its offer', async () => {
  const source = new Set(['a', 'b']);
  const selectable = counterOffer({
    refine(current, names) {
      for (const name of names) if (!current.has(name)) throw new Error('Cannot expand access');
      return new Set(names);
    },
  });
  const other = counterOffer();
  const supply = ResourceSupply.capture([selectable.provide(() => source), other.provide(() => 12)], undefined);
  const rule = selectable.refine((input) => input.names);
  const selected = supply.refine({ names: ['b'] }, [rule]);
  assert.equal(selected.require(other.request().offer), supply.require(other.request().offer));
  assert.equal(selected.require(selectable.request().offer).offer, supply.require(selectable.request().offer).offer);
  assert.notEqual(selected.require(selectable.request().offer).supplyId, supply.require(selectable.request().offer).supplyId);
  assert.deepEqual([...selected.require(selectable.request().offer).readMaterial()], ['b']);
  assert.deepEqual([...supply.require(selectable.request().offer).readMaterial()], ['a', 'b']);
  assert.throws(() => supply.refine({ names: ['c'] }, [rule]), /Cannot expand/);
  assert.equal('capture' in supply.entries[0], false);
  assert.equal('get' in supply.entries[0], false);
});

test('an unavailable owner is rejected before eager source capture', () => {
  let captures = 0;
  const offer = counterOffer({
    timing: 'binding',
    capture: (source) => {
      captures++;
      return source;
    },
  });
  const binding = new Resources().register(new Resource(1), offer).bind({ value: offer.request() });
  const unavailable = new Error('host ended');
  assert.throws(
    () =>
      binding.open({
        ...owner(),
        validate() {
          throw unavailable;
        },
      }),
    (error) => error === unavailable,
  );
  assert.equal(captures, 0);
});

test('ambiguous supply is rejected before any eager material capture', () => {
  let captures = 0;
  const offer = counterOffer({ timing: 'binding', capture: () => ++captures });
  const provider = offer.provide(() => null);
  assert.throws(() => ResourceSupply.capture([provider, provider], undefined), /Ambiguous resource supply/);
  assert.equal(captures, 0);
});

test('registry binding and access preserve source, dependency, operation and host types', async () => {
  const entry = fileURLToPath(new URL('./types/resource-binding-access.ts', import.meta.url));
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
