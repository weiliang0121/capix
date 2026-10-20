import { contextWithSource } from './observer.mjs';
import { Invocation, InvocationChildren, CallableContext, bindInvocationObservation, invocationRecording, Clock } from '@capix/server-runtime';
import { fixtureState } from './runtime.mjs';
import { callFor, recordFor, rememberCall } from './calls.mjs';
export { callFor, recordFor, rememberCall } from './calls.mjs';

const origins = new WeakMap();
const manual = new WeakMap();

/** Explicit record probes for synchronous ownership tests; these are not executed calls. */
export function lifecycleFor(runtime) {
  const state = fixtureState(runtime);
  const make = (kind, establish, description, declarations = state.observe) => ({
    create(execute) {
      const { context, parent, root } = establish();
      const identity = { contextId: context.id, kind, parentContextId: parent.context.id };
      const observation = bindInvocationObservation({ identity, description, declarations, resources: context.resources }, state.recording ? [state.recording] : [], parent.observation);
      const clock = state.recorder?.clock ?? new Clock();
      if (execute) {
        const invocation = state.decorate(new Invocation({ context, parent: { invocation: parent }, identity, description, observation, clock, work: { execute, raises: description?.raises, maxRounds: 1 }, signal: context.signal }));
        attach(context, invocation);
        return { invocation, root, parent };
      }
      let sequence = 0;
      let fault;
      const publish = (change) => observation.publish({ ...change, identity, description, eventSequence: ++sequence, occurredAt: clock.now(), monotonicTime: clock.tick() });
      const invocation = {
        context,
        observation,
        origin: { contextId: context.id },
        requireHealthy() {
          if (fault) throw fault;
        },
        requireActive() {
          this.requireHealthy();
          context.requireActive();
        },
        reject(error) {
          fault = error;
        },
        run() {
          throw new Error('Manual record probe is not an executable Invocation');
        },
      };
      invocation.children = new InvocationChildren(
        context,
        (failure) => {
          if (failure.kind === 'error') fault = failure.error;
        },
        () => invocation.requireHealthy(),
        (relation, change) => publish({ kind: 'relation', relation, change }),
      );
      state.decorate(invocation);
      const relation = parent.children.attach(invocation);
      attach(context, invocation);
      manual.set(context, { invocation, publish, relation, root });
      return { invocation, publish, root, parent };
    },
    begin() {
      const { invocation, publish } = this.create();
      const context = invocation.context;
      try {
        const failure = publish({ kind: 'started', input: context.input });
        if (failure) throw failure;
        context.resources.start();
      } catch (error) {
        if (context.status === 'running') context.fail(error);
        throw error;
      }
      return context;
    },
    succeed(context, output) {
      const probe = manual.get(context);
      context.complete(output);
      const error = probe.publish({ kind: 'finished', state: context.state });
      if (error) throw error;
      probe.relation.returnedWith({ status: 'succeeded', output });
      probe.root?.resolve(null);
    },
    fail(context, error) {
      const probe = manual.get(context);
      context.fail(error);
      const observed = probe.publish({ kind: 'finished', state: context.state });
      probe.relation.returnedWith({ status: 'failed', error });
      probe.root?.reject(error);
      if (observed) throw observed;
    },
  });
  return {
    execution(request) {
      return make(
        'group',
        () => {
          const root = state.beginRuntime(request);
          const context = contextWithSource(request.input, request, root.call.context);
          return { context, parent: root.call, root };
        },
        undefined,
        state.recorder ? [invocationRecording({ role: 'conversation-task' })] : [],
      );
    },
    operation(execution, operation, input, parent) {
      if (parent && origins.get(parent) !== execution) throw new Error('Parent operation belongs to another execution');
      return make(
        'group',
        () => {
          execution.requireRunning();
          parent?.requireRunning();
          const owner = parent ?? execution;
          const context = new CallableContext(input, 'group', { signal: owner.signal });
          origins.set(context, execution);
          return { context, parent: callFor(owner) };
        },
        operation,
      );
    },
    attempt(operation, attempt, input) {
      return make(
        'node',
        () => {
          operation.requireActive();
          return { context: new CallableContext(input, 'node', { signal: operation.signal }), parent: callFor(operation) };
        },
        attempt,
      );
    },
  };
}

function attach(context, invocation) {
  context.resources.attach({
    contextId: context.id,
    validate: () => {
      invocation.requireHealthy();
      context.requireActive();
    },
    observation: invocation.observation.resource,
    transcript: invocation.observation.transcript,
    memory: invocation.observation.memory,
    error: (error) => invocation.reject(error),
  });
}

export async function invoke(lifecycle, execute) {
  const { invocation, root, parent } = lifecycle.create(execute);
  try {
    const output = await invocation.run();
    if (root) {
      const accepted = await parent.children.get(invocation).accept(() => null);
      root.resolve(accepted);
      await root.completion;
    }
    return output;
  } catch (error) {
    root?.reject(error);
    if (root) await root.completion.catch(() => {});
    throw error;
  }
}
