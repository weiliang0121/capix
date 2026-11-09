// Diagnostic probes, not a recommended application pattern. No real model or disk store.
// `node examples/invocation-exit.mjs` exits nonzero while an exit guarantee is unmet.
import { Resource, ResourceOffer, ResourceSupply } from '@weiliang0121/capix-resources';
import { CallableContext, Invocation, InvocationResources, invocationResourceFailures } from '@weiliang0121/capix-invocation';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { Scene, Resources, Runner } from '@weiliang0121/capix-runtime';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function contains(error, expected, seen = new Set()) {
  if (error === expected) return true;
  if (!(error instanceof Error) || seen.has(error)) return false;
  seen.add(error);
  return contains(error.cause, expected, seen) || (error instanceof AggregateError && error.errors.some((item) => contains(item, expected, seen)));
}

function pendingResource(cleanupFailure) {
  const response = deferred();
  const offer = new ResourceOffer({
    methods: {
      read(_origin, _input, operation) {
        operation.onClose(() => {
          throw cleanupFailure;
        });
        return response.promise;
      },
    },
  });
  let pending;
  return {
    offer,
    start(endpoint) {
      pending = endpoint.read();
      void pending.catch(() => undefined); // Probe owns this intentionally unawaited operation.
    },
    async finish() {
      response.resolve('late resource result');
      await pending?.catch(() => undefined);
    },
  };
}

async function failurePreservation() {
  const bodyFailure = new Error('business body failed');
  const cleanupFailure = new Error('resource cleanup failed');
  const pending = pendingResource(cleanupFailure);
  const scene = new Scene({
    deps: { data: pending.offer.request() },
    run(work) {
      pending.start(work.resources.data);
      throw bodyFailure;
    },
  });
  const runner = new Runner(scene, new Resources().register(new Resource(null), pending.offer)).build();
  let delivered;
  try {
    await runner.run(null);
  } catch (error) {
    delivered = error;
  } finally {
    await pending.finish();
  }
  return {
    probe: 'body failure plus cleanup failure',
    checks: { bodyFailurePreserved: contains(delivered, bodyFailure), cleanupFailurePreserved: contains(delivered, cleanupFailure), runnerReleased: !runner.isRunning },
    observed: { delivered: delivered?.message, cause: delivered?.cause?.message },
  };
}

async function checkpointRelease() {
  const cleanupFailure = new Error('resource cleanup failed');
  const pending = pendingResource(cleanupFailure);
  const deps = { data: pending.offer.request() };
  const supply = ResourceSupply.capture([pending.offer.provide(() => null)], undefined);
  const resources = new InvocationResources(deps, supply.entries);
  const context = new CallableContext(null, 'node', {}, resources);
  const store = new MemoryCheckpointStore();
  const call = new Invocation({
    context,
    signal: context.signal,
    checkpoints: { store },
    work: {
      execute(current) {
        pending.start(current.resources.values.data);
        return 'body result';
      },
    },
  });
  resources.attach({ contextId: context.id, signal: context.signal, failures: invocationResourceFailures, validate: () => call.requireActive(), error: (error, allow) => call.reject(error, allow) });
  let delivered;
  let nextResult;
  let nextError;
  try {
    try {
      await call.run();
    } catch (error) {
      delivered = error;
    }
    // Diagnostic only: reuse the Context ID to query local exclusion, not to resume business.
    // No CP point was written, so this probe does not claim a recoverable execution exists.
    const nextContext = new CallableContext(null, 'node');
    nextContext.installIdentity(context.id);
    const next = new Invocation({ context: nextContext, signal: nextContext.signal, checkpoints: { store }, work: { execute: () => 'second result' } });
    try {
      nextResult = await next.run();
    } catch (error) {
      nextError = error;
    }
  } finally {
    await pending.finish();
  }
  return {
    probe: 'low-level cleanup and checkpoint claim release',
    checks: { cleanupFailurePreserved: contains(delivered, cleanupFailure), checkpointClaimReleased: nextResult === 'second result' },
    observed: { delivered: delivered?.message, contextStatus: context.status, invocationFailureRecorded: !!call.failure, nextError: nextError?.message },
  };
}

const probes = [await failurePreservation(), await checkpointRelease()];
console.log(JSON.stringify(probes, null, 2));
if (probes.some((probe) => Object.values(probe.checks).some((passed) => !passed))) process.exitCode = 1;
