import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Resource, Resources, ResourceOffer, Runner, Scene, Node, bindResources, ChangeCaptureError, InvocationCancelled, ExceptionContract } from '@capix/server-runtime';

function binding(offer, origin, overrides = {}) {
  const faults = [];
  const facts = [];
  const access = bindResources({ value: offer.request() }, [offer.provide(() => origin)])(null);
  access.attach({
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
  access.start();
  return { access, endpoint: access.values.value, faults, facts };
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
  assert.equal(endpoint, access.values.value);
  source.values.push(3);
  assert.deepEqual(endpoint, [1, 2]);
  const child = access.select({ value: offer.request() }, undefined, { input: 1, refinements: [rule] });
  child.attach({ contextId: 'child', validate() {} });
  child.start();
  assert.deepEqual(child.values.value, [1]);
  assert.deepEqual(access.values.value, [1, 2]);
  assert.ok(facts.some((fact) => fact.describe()?.count === 2));
});

test('method capture and refinement preserve independent child scopes while sharing one immutable supply', async () => {
  const source = { values: [1, 2, 3] };
  let captures = 0;
  const offer = new ResourceOffer({
    capture(origin) {
      captures++;
      return Object.freeze([...origin.values]);
    },
    refine(values, selection) {
      if (!values.includes(selection)) throw new Error('Cannot widen resource scope');
      return Object.freeze([selection]);
    },
    methods: {
      read(values) {
        return values;
      },
    },
  });
  const child = new Node({ deps: { source: offer.request() }, run: (work) => work.resources.source.read(undefined) });
  const scene = new Scene({
    deps: { source: offer.request() },
    uses: [child],
    async run(work) {
      const full = await work.resources.source.read(undefined);
      const subsets = await Promise.all(work.input.map((selection) => work.children.invoke(child, selection)));
      assert.equal(await work.resources.source.read(undefined), full);
      return { full, subsets };
    },
  }).add(child);
  const resources = new Resources().register(new Resource(source), offer).refine(
    child,
    offer.refine((input) => input),
  );
  const runner = new Runner(scene, resources).build();
  assert.equal(captures, 0);
  assert.deepEqual(await runner.run([1, 3]), { full: [1, 2, 3], subsets: [[1], [3]] });
  assert.equal(captures, 1);
  await assert.rejects(runner.run([4]), /Cannot widen resource scope/);
});

test('an offer rejects mixed endpoint declarations', () => {
  assert.throws(() => new ResourceOffer({ methods: { read: () => 1 }, expose: () => 1 }), /either methods or precise exposure/);
});

test('an offer requires a configuration object and rejects the removed positional constructor', () => {
  assert.throws(() => new ResourceOffer('legacy', (value) => value, 'binding', { capture: (value) => value }), /requires a configuration object/);
  assert.throws(() => new ResourceOffer({ name: 'missing-endpoint' }), /requires an endpoint declaration/);
});

test('resource methods register an origin directly and preserve successful values by reference', async () => {
  const origin = { value: { text: 'one' } };
  const resource = new Resource(origin);
  const offer = new ResourceOffer({
    methods: {
      read(source, input) {
        assert.equal(input, 'requested');
        return source.value;
      },
    },
  });
  const seen = [];
  const scene = new Scene({
    deps: { source: offer.request() },
    run(work) {
      seen.push(work.resources.source);
      return work.resources.source.read(work.input);
    },
  });
  const resources = new Resources().register(resource, offer);
  const runner = new Runner(scene, resources).build();
  assert.equal(resource.origin, origin);
  assert.equal(await runner.run('requested'), origin.value);
  origin.value = { text: 'two' };
  assert.equal(await runner.run('requested'), origin.value);
  assert.notEqual(seen[0], seen[1]);
  await assert.rejects(seen[0].read('requested'), /ended|running|closed/);
  assert.throws(() => resources.register(resource, offer), /Duplicate resource registration/);
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

test('closed windows and in-flight cancellation bypass business failure reception', async () => {
  let finish;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const controller = new AbortController();
  const offer = new ResourceOffer({
    methods: {
      async read() {
        started();
        await new Promise((resolve) => {
          finish = resolve;
        });
        return 'late';
      },
    },
  });
  let failureCalls = 0;
  const { access, endpoint } = binding(offer, null, {
    validate() {
      if (controller.signal.aborted) throw new InvocationCancelled(controller.signal);
    },
  });
  const result = endpoint.read(undefined, {
    result: {
      failed() {
        failureCalls++;
        return 'hidden';
      },
    },
  });
  await ready;
  controller.abort();
  finish();
  await assert.rejects(result, InvocationCancelled);
  access.close('run');
  await assert.rejects(
    endpoint.read(undefined, {
      result: {
        failed() {
          failureCalls++;
          return 'hidden';
        },
      },
    }),
    (error) => error instanceof InvocationCancelled || /closed/.test(error.message),
  );
  assert.equal(failureCalls, 0);
});

test('source failures racing cancellation retain the original fault and never run failure reception', async () => {
  const declared = new ExceptionContract('resource-race');
  for (const failure of [new Error('IO failed'), new ChangeCaptureError({ changed: true }, new Error('capture')), declared.create('IO declared', {})]) {
    for (const withReceiver of [false, true]) {
      const controller = new AbortController();
      let handled = 0;
      const offer = new ResourceOffer({
        methods: {
          async read() {
            controller.abort('cancel');
            throw failure;
          },
        },
      });
      const scene = new Scene({
        raises: [declared],
        deps: { files: offer.request() },
        run: (work) =>
          work.resources.files.read(
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
          ),
      });
      const runner = new Runner(scene, new Resources().register(new Resource({}), offer)).build();
      await assert.rejects(runner.run(null, { signal: controller.signal }), (error) => error instanceof AggregateError && error.cause === failure && error.errors[0] === failure && error.errors[1] instanceof InvocationCancelled);
      assert.equal(handled, 0);
      assert.equal(runner.isRunning, false);
    }
  }
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
    access.close('run');
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

test('resource aggregate eligibility handles cycles and refuses opaque protected failures without executing getters', async () => {
  const cyclic = new AggregateError([], 'cyclic');
  cyclic.errors.push(cyclic);
  const offer = new ResourceOffer({
    methods: {
      read(source) {
        throw source;
      },
    },
  });
  assert.equal(
    await binding(offer, cyclic).endpoint.read(undefined, {
      result: {
        failed(error) {
          assert.equal(error, cyclic);
          return 'handled';
        },
      },
    }),
    'handled',
  );
  const protectedFailure = new ChangeCaptureError({ kind: 'committed' }, new Error('capture'));
  cyclic.errors.push(new AggregateError([cyclic, protectedFailure], 'nested'));
  let handled = 0;
  await assert.rejects(
    binding(offer, cyclic).endpoint.read(undefined, {
      result: {
        failed() {
          handled++;
          return 'wrong';
        },
      },
    }),
    (error) => error === cyclic,
  );
  const opaque = new AggregateError([], 'opaque');
  let reads = 0;
  Object.defineProperty(opaque, 'errors', {
    get() {
      reads++;
      throw new Error('getter');
    },
  });
  await assert.rejects(
    binding(offer, opaque).endpoint.read(undefined, {
      result: {
        failed() {
          handled++;
          return 'wrong';
        },
      },
    }),
    (error) => error === opaque,
  );
  assert.equal(handled, 0);
  assert.equal(reads, 0);
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

test('unawaited resource operations do not retain the invocation window or become managed child calls', async () => {
  let finish;
  let pending;
  let failed = 0;
  const offer = new ResourceOffer({
    methods: {
      async read() {
        await new Promise((resolve) => {
          finish = resolve;
        });
        return 'late';
      },
    },
  });
  const scene = new Scene({
    deps: { file: offer.request() },
    run(work) {
      pending = work.resources.file.read(undefined, {
        result: {
          failed() {
            failed++;
            return 'hidden';
          },
        },
      });
      void pending.catch(() => undefined);
      return 'finished';
    },
  });
  const runner = new Runner(scene, new Resources().register(new Resource(null), offer)).build();
  assert.equal(await runner.run(null), 'finished');
  finish();
  await assert.rejects(pending, /running|closed|ended/);
  assert.equal(failed, 0);
});

test('method access exposes only declared operations and offer identity is not its display name', async () => {
  const origin = { visible: 'readable', secret: 'host-only' };
  const declaration = {
    name: 'same-name',
    methods: {
      read(source) {
        return source.visible;
      },
    },
  };
  const offer = new ResourceOffer(declaration);
  const unrelated = new ResourceOffer(declaration);
  const { endpoint } = binding(offer, origin);
  assert.deepEqual(Object.keys(endpoint), ['read']);
  assert.equal(endpoint.origin, undefined);
  assert.equal(endpoint.secret, undefined);
  assert.equal(await endpoint.read(undefined), 'readable');
  const scene = new Scene({ deps: { source: unrelated.request() }, run: (work) => work.resources.source.read(undefined) });
  assert.throws(() => new Runner(scene, new Resources().register(new Resource(origin), offer)).build(), /Expected one resource provider/);
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

test('resource requests preserve source types and business Work only exposes declared access', () => {
  const file = fileURLToPath(new URL('./types/resources.ts', import.meta.url));
  const errors = ts.getPreEmitDiagnostics(ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }));
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
});
