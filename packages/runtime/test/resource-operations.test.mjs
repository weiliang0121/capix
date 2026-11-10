import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resources, Runner, Scene, Node } from '@weiliang0121/capix-runtime';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { invocationResourceFailures } from '@weiliang0121/capix-runtime/construction';
import { InvocationCancelled } from '@weiliang0121/capix-runtime';
import { Resources as ResourceRegistry } from '@weiliang0121/capix-resources';
import { ExceptionContract } from '@weiliang0121/capix-runtime';
import { ChangeCaptureError } from '@weiliang0121/capix-changes';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function binding(offer, origin, overrides = {}) {
  const faults = [];
  const facts = [];
  const access = new ResourceRegistry()
    .register(new Resource(origin), offer)
    .bind({ value: offer.request() })
    .open({
      failures: invocationResourceFailures,
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

test('resource methods preserve origin values while invocation delivery fixes them', async () => {
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
    async run(work) {
      seen.push(work.resources.source);
      const value = await work.resources.source.read(work.input);
      assert.equal(value, origin.value);
      assert.equal(Object.isFrozen(value), false);
      return value;
    },
  });
  const resources = new Resources().register(resource, offer);
  const runner = new Runner(scene, resources).build();
  assert.equal(resource.origin, origin);
  assert.deepEqual(await runner.run('requested'), origin.value);
  origin.value = { text: 'two' };
  assert.deepEqual(await runner.run('requested'), origin.value);
  assert.notEqual(seen[0], seen[1]);
  await assert.rejects(seen[0].read('requested'), /ended|running|closed/);
  assert.throws(() => resources.register(resource, offer), /Duplicate resource registration/);
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
  access.close();
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

test('resource requests preserve source types and business Work only exposes declared access', () => {
  const file = fileURLToPath(new URL('./types/resources.ts', import.meta.url));
  const errors = ts.getPreEmitDiagnostics(ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }));
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
});

for (const failed of [false, true]) {
  test(`cancellation published with a resource ${failed ? 'failure' : 'success'} prevents entering its result receiver`, async () => {
    const controller = new AbortController();
    const failure = new Error('source failure');
    let received = 0;
    const offer = new ResourceOffer({
      methods: {
        read() {
          if (failed) throw failure;
          return 'value';
        },
      },
    });
    const scene = new Scene({
      deps: { read: offer.request() },
      run: (work) =>
        work.resources.read.read(undefined, {
          result: {
            succeeded: () => {
              received++;
              return 'accepted';
            },
            failed: () => {
              received++;
              return 'handled';
            },
          },
        }),
    });
    const observations = [
      {
        bindInvocation: () => ({
          observe() {},
          resource(fact) {
            if (fact.phase === (failed ? 'threw' : 'returned')) controller.abort();
          },
        }),
      },
    ];
    const runner = new Runner(scene, new Resources().register(new Resource(null), offer), undefined, { observations }).build();
    await assert.rejects(runner.run(null, { signal: controller.signal }), (error) => (failed ? error instanceof AggregateError && error.cause === failure : error instanceof InvocationCancelled));
    assert.equal(received, 0);
  });
}
