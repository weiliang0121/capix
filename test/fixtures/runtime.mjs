import { randomUUID } from 'node:crypto';
import { RuntimeRecordHelper, RuntimeCallRecord, InvocationBoundaryRecordHelper, createRuntime as createCoreRuntime, bindRecording, callRecording, ResourceBindings, ExecutionRecordHelper } from '@capix-observer/runtime';
import { rememberCall } from './calls.mjs';

const states = new WeakMap();
export function fixtureState(runtime) {
  const state = states.get(runtime);
  if (!state) throw new Error('Runtime was not established by the test fixture');
  return state;
}

/** Low-level tests explicitly assemble recording and a genuine parent R call. */
export function createRuntime({ recorder, ...options } = {}) {
  const scopes = new Map();
  const recording = recorder ? bindRecording(recorder, { failure: 'propagate' }) : undefined;
  if (recording) {
    const bind = recording.bindCall.bind(recording);
    recording.bindCall = (setup, parent) => {
      const scope = bind(setup, parent);
      scopes.set(setup.identity.contextId, scope);
      return scope;
    };
  }
  const runtime = createCoreRuntime({ ...options, ...(recorder ? { clock: recorder.clock, observations: [...(options.observations ?? []), recording] } : {}) });
  const state = { scopes, recording, recorder, runtime, observe: recorder ? [callRecording()] : [] };
  states.set(runtime, state);
  // Kept only on the test fixture to make legacy record assertions explicit.
  Object.defineProperties(runtime, { recording: { value: recording }, recorder: { value: recorder }, record: { get: () => recording?.root } });
  const decorate = (invocation) => {
    Object.defineProperty(invocation, 'record', { get: () => scopes.get(invocation.context.id)?.record });
    return rememberCall(invocation);
  };
  state.decorate = decorate;
  for (const builder of [runtime.operationInvocations, runtime.attemptInvocations]) {
    const create = builder.create.bind(builder);
    builder.create = (parent, request) => decorate(create(parent, { ...request, observation: request.observation ?? state.observe }));
  }
  const createE = runtime.executionInvocations.create.bind(runtime.executionInvocations);
  state.createExecution = (parent, input, request) => decorate(createE(parent, input, { ...request, observation: request.observation ?? state.observe }));
  state.beginRuntime = (context = {}) => {
    let resolve;
    let reject;
    const pending = new Promise((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const call = decorate(runtime.runtimeInvocations.create(null, { context, resources: new ResourceBindings({}), observation: recorder ? [callRecording({ input: () => null, output: () => null })] : [], work: { maxRounds: 1, execute: () => pending } }));
    const completion = call.run();
    // Some manual lifecycle fixtures deliberately retain a running parent.
    completion.catch(() => {});
    return { call, completion, resolve, reject };
  };
  runtime.executionInvocations.create = (input, request) => {
    const parent = state.beginRuntime(request.context);
    let invocation;
    try {
      invocation = state.createExecution(parent.call, input, request);
    } catch (error) {
      parent.reject(error);
      throw error;
    }
    const run = invocation.run.bind(invocation);
    invocation.run = async () => {
      try {
        const output = await run();
        const accepted = await parent.call.children.get(invocation).accept(() => null);
        parent.resolve(accepted);
        await parent.completion;
        return output;
      } catch (error) {
        parent.reject(error);
        await parent.completion.catch(() => {});
        throw error;
      }
    };
    return invocation;
  };
  runtime.executionInvocations.submit = (accept, request) => runtime.executionInvocations.create(accept(), request).run();
  return runtime;
}

export function observeCall(recording, invocation) {
  const record = invocation.record;
  if (!record || recording.recorder.tree.root(record.id) !== recording.root) throw new Error('Execution record does not exist');
  return ExecutionRecordHelper.snapshot(recording.recorder, record.id);
}

/** Record-only ownership fixture; no execution of work is implied. */
export function createRecordScope(recorder) {
  const root = RuntimeRecordHelper.create(recorder);
  const record = recorder.add(new RuntimeCallRecord(randomUUID(), randomUUID(), { input: null, startedAt: recorder.clock.now() }, root.id));
  InvocationBoundaryRecordHelper.create(recorder, { start: recorder.clock.tick(), scopeId: record.id, callId: record.id }, 'call');
  return record;
}
