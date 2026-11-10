import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resource, ResourceOffer, ResourceBinding, Resources as ResourceRegistry } from '@weiliang0121/capix-resources';
import { ChangeCaptureError } from '@weiliang0121/capix-changes';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const hostFailures = {
  isProtected: (error) => error instanceof ChangeCaptureError,
  isCancellation: () => false,
  describe: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
};

function binding(offer, origin, overrides = {}) {
  const faults = [];
  const facts = [];
  const access = new ResourceRegistry()
    .register(new Resource(origin), offer)
    .bind({ value: offer.request() })
    .open({
      failures: hostFailures,
      contextId: 'resource-operation',
      validate() {},
      error: (error) => faults.push(error),
      observation: {
        publish: (fact) => {
          facts.push(fact);
        },
      },
      ...overrides,
    });
  return { access, endpoint: access.endpoints.value, faults, facts };
}

test('named exposure preserves synchronous values and fixes callback entries with their original receiver', () => {
  const source = { values: [1, 2] };
  const calls = [];
  const declaration = {
    name: 'snapshot',
    timing: 'binding',
    capture(value) {
      assert.equal(this, declaration);
      calls.push('capture');
      return Object.freeze([...value.values]);
    },
    expose(value) {
      assert.equal(this, declaration);
      calls.push('expose');
      return value;
    },
    describe(value) {
      assert.equal(this, declaration);
      return { count: value.length };
    },
    refine(value, length) {
      assert.equal(this, declaration);
      return value.slice(0, length);
    },
  };
  const offer = new ResourceOffer(declaration);
  const rule = offer.refine((length) => length);
  for (const method of ['capture', 'expose', 'describe', 'refine']) declaration[method] = () => assert.fail('declaration entry changed after publication');
  const { access, endpoint, facts } = binding(offer, source);
  assert.deepEqual(calls, ['capture', 'expose']);
  assert.deepEqual(endpoint, [1, 2]);
  assert.equal(endpoint, access.endpoints.value);
  source.values.push(3);
  assert.deepEqual(endpoint, [1, 2]);
  const child = ResourceBinding.fromSupply({ value: offer.request() }, access.supply.refine(1, [rule])).open({ failures: hostFailures, contextId: 'child', validate() {} });
  assert.deepEqual(child.endpoints.value, [1]);
  assert.deepEqual(access.endpoints.value, [1, 2]);
  assert.ok(facts.some((fact) => fact.describe()?.count === 2));
});

test('an offer rejects mixed endpoint declarations', () => {
  assert.throws(() => new ResourceOffer({ methods: { read: () => 1 }, expose: () => 1 }), /either methods or precise exposure/);
});

test('an offer requires a configuration object and rejects the removed positional constructor', () => {
  assert.throws(() => new ResourceOffer('legacy', (value) => value, 'binding', { capture: (value) => value }), /requires a configuration object/);
  assert.throws(() => new ResourceOffer({ name: 'missing-endpoint' }), /requires an endpoint declaration/);
});

test('success and failure receivers run only after the resource operation outcome is established', async () => {
  const failure = new Error('missing file');
  const offer = new ResourceOffer({
    methods: {
      read(source, fail) {
        if (fail) throw failure;
        return source;
      },
    },
  });
  const value = { text: 'existing' };
  const { endpoint, faults, facts } = binding(offer, value);
  assert.equal(await endpoint.read(false), value);
  assert.equal(await endpoint.read(false, { result: { succeeded: (output) => output.text } }), 'existing');
  assert.equal(
    await endpoint.read(true, {
      result: {
        failed(error) {
          assert.equal(error, failure);
          return 'fallback';
        },
      },
    }),
    'fallback',
  );
  assert.deepEqual(faults, []);
  assert.equal(facts.filter((fact) => fact.phase === 'returned').length, 2);
  assert.equal(facts.filter((fact) => fact.phase === 'threw').length, 1);
});

test('an unhandled resource failure remains the original failure and becomes owned by the invocation', async () => {
  const failure = new Error('resource unavailable');
  const offer = new ResourceOffer({
    methods: {
      read() {
        throw failure;
      },
    },
  });
  const { endpoint, faults } = binding(offer, null);
  await assert.rejects(endpoint.read(undefined), (error) => error === failure);
  assert.deepEqual(faults, [failure]);
});

test('receiver exceptions never re-enter the same operation failure receiver', async () => {
  const failure = new Error('receiver failed');
  let failureCalls = 0;
  const offer = new ResourceOffer({
    methods: {
      read(source) {
        return source;
      },
    },
  });
  const { endpoint, faults } = binding(offer, 'value');
  await assert.rejects(
    endpoint.read(undefined, {
      result: {
        succeeded() {
          throw failure;
        },
        failed() {
          failureCalls++;
          return 'hidden';
        },
      },
    }),
    (error) => error === failure,
  );
  assert.equal(failureCalls, 0);
  assert.deepEqual(faults, [failure]);
});

test('source failures racing window closure are retained with and without failure reception', async () => {
  for (const withReceiver of [false, true]) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const failure = new Error('source failed');
    const offer = new ResourceOffer({
      methods: {
        async read() {
          await gate;
          throw failure;
        },
      },
    });
    const { endpoint, access, faults } = binding(offer, null);
    let handled = 0;
    const result = endpoint.read(
      undefined,
      withReceiver
        ? {
            result: {
              failed() {
                handled++;
                return 'wrong';
              },
            },
          }
        : undefined,
    );
    access.close();
    release();
    await assert.rejects(result, (error) => error instanceof AggregateError && error.cause === failure && error.errors[0] === failure && /closed/.test(error.errors[1].message));
    assert.equal(handled, 0);
    assert.equal(faults.length, 1);
    assert.equal(faults[0].cause, failure);
  }
});

test('observer and required entity-capture failures cannot become successful resource results', async () => {
  let failureCalls = 0;
  const receiver = {
    result: {
      failed() {
        failureCalls++;
        return 'hidden';
      },
    },
  };
  const captureFailure = new ChangeCaptureError({ changed: true }, new Error('disk'));
  const offer = new ResourceOffer({
    methods: {
      read() {
        throw captureFailure;
      },
    },
  });
  const first = binding(offer, null);
  await assert.rejects(first.endpoint.read(undefined, receiver), (error) => error === captureFailure);
  const observed = new ResourceOffer({
    methods: {
      read() {
        return 'done';
      },
    },
  });
  const observationFailure = new Error('observer failed');
  const second = binding(observed, null, { observation: { publish: (fact) => (fact.phase === 'returned' ? observationFailure : undefined) } });
  await assert.rejects(second.endpoint.read(undefined, receiver), (error) => error === observationFailure);
  assert.equal(failureCalls, 0);
});

test('delta consumers are isolated and producer endpoints are sealed after operation completion', async () => {
  let saved;
  let delivered = 0;
  const offer = new ResourceOffer({
    methods: {
      read(_source, _input, operation) {
        saved = operation;
        operation.emit('a');
        operation.emit('b');
        return 'ab';
      },
    },
  });
  const { endpoint } = binding(offer, null);
  assert.equal(
    await endpoint.read(undefined, {
      delta() {
        delivered++;
        throw new Error('view closed');
      },
    }),
    'ab',
  );
  assert.equal(delivered, 1);
  assert.throws(() => saved.emit('late'), /output is closed/);
});

test('resource method entries are fixed while their original receiver and origin remain usable', async () => {
  const methods = {
    read(source) {
      return `${source.text}:${this === methods}`;
    },
  };
  const offer = new ResourceOffer({ methods });
  methods.read = () => assert.fail('replacement method must not become installed');
  const { endpoint } = binding(offer, { text: 'value' });
  assert.equal(await endpoint.read(undefined), 'value:true');
});

test('resource failure reception is fixed when the operation starts', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const offer = new ResourceOffer({
    methods: {
      async read() {
        await gate;
        throw new Error('read failed');
      },
    },
  });
  const { endpoint } = binding(offer, null);
  const receiver = {
    failed() {
      assert.equal(this, receiver);
      return 'original';
    },
  };
  const options = { result: receiver };
  const result = endpoint.read(undefined, options);
  receiver.failed = () => 'replacement';
  options.result = { failed: () => 'new receiver' };
  release();
  assert.equal(await result, 'original');
});

test('resource operations receive their own invocation signal without a business signal argument', async () => {
  const controller = new AbortController();
  let actualSignal;
  const offer = new ResourceOffer({
    methods: {
      read(_source, _input, operation) {
        actualSignal = operation.signal;
        return 'value';
      },
    },
  });
  const { endpoint } = binding(offer, null, { signal: controller.signal });
  assert.equal(await endpoint.read(undefined), 'value');
  assert.equal(actualSignal, controller.signal);
});

test('method observation records only explicit source and operation descriptions', async () => {
  const origin = { text: 'private body', name: 'source.md' };
  const offer = new ResourceOffer({
    methods: {
      read(source, input) {
        assert.equal(input.private, 'hidden input');
        return source;
      },
    },
    observation: {
      source: (source) => ({ name: source.name }),
      methods: { read: { input: (input) => ({ key: input.key }), output: (output) => ({ name: output.name }) } },
    },
  });
  const { endpoint, facts } = binding(offer, origin);
  assert.equal(await endpoint.read({ key: 'lookup', private: 'hidden input' }), origin);
  const described = facts.map((fact) => ({ phase: fact.phase, detail: fact.describe() }));
  assert.deepEqual(described.find((fact) => fact.phase === 'available').detail, { name: 'source.md' });
  assert.deepEqual(described.find((fact) => fact.phase === 'started').detail, { action: 'read', input: { key: 'lookup' } });
  assert.deepEqual(described.find((fact) => fact.phase === 'returned').detail, { action: 'read', output: { name: 'source.md' } });
  assert.equal(JSON.stringify(described).includes('private body'), false);
  assert.equal(JSON.stringify(described).includes('hidden input'), false);
});

test('rejected async delta consumers detach without changing operation results', async () => {
  let received = 0;
  const offer = new ResourceOffer({
    methods: {
      async read(_source, _input, operation) {
        operation.emit('first');
        await Promise.resolve();
        operation.emit('second');
        return 'result';
      },
    },
  });
  const { endpoint } = binding(offer, null);
  assert.equal(
    await endpoint.read(undefined, {
      async delta() {
        received++;
        throw new Error('consumer closed');
      },
    }),
    'result',
  );
  assert.equal(received, 1);
});

test('a failure receiver that throws is a reception failure and is not retried', async () => {
  const original = new Error('operation');
  const reception = new Error('receiver');
  let received = 0;
  const offer = new ResourceOffer({
    methods: {
      read() {
        throw original;
      },
    },
  });
  const { endpoint, facts, faults } = binding(offer, null);
  await assert.rejects(
    endpoint.read(undefined, {
      result: {
        failed() {
          received++;
          throw reception;
        },
      },
    }),
    (error) => error === reception,
  );
  assert.equal(received, 1);
  assert.deepEqual(faults, [reception]);
  assert.equal(facts.filter((fact) => fact.phase === 'threw').length, 1);
});

test('malformed receiver callbacks are rejected before any resource operation starts', async () => {
  let started = 0;
  const offer = new ResourceOffer({
    methods: {
      read() {
        started++;
        return 'done';
      },
    },
  });
  const { endpoint } = binding(offer, null);
  for (const options of [{ delta: 1 }, { result: { succeeded: true } }, { result: { failed: 'invalid' } }]) {
    await assert.rejects(endpoint.read(undefined, options), /receiver must be a function/);
  }
  assert.equal(started, 0);
});

const typeSource = readFileSync(new URL('./types/resource-operations.ts', import.meta.url), 'utf8');

function diagnostics(source) {
  const file = fileURLToPath(new URL('./types/resource-operations.ts', import.meta.url));
  const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (current, ...args) => (current === file ? ts.createSourceFile(file, source, options.target, true) : original(current, ...args));
  return ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
}

test('resource method declarations infer source, input, result branches and delta types', () => {
  const errors = diagnostics(typeSource);
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
});

test('resource method contract counterexamples fail rather than being widened by callbacks', () => {
  const errors = diagnostics(typeSource.replaceAll('@ts-expect-error', 'expected error'));
  assert.equal(errors.length, typeSource.match(/@ts-expect-error/g).length);
});
