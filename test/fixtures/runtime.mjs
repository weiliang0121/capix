import { randomUUID } from 'node:crypto';
import { RecordingRootHelper, RuntimeCallRecord, InvocationBoundaryRecordHelper, createBoundRuntime as createCoreRuntime, bindRecording, invocationRecording, ResourceBindings, ExecutionRecordHelper } from '@capix/server-runtime';
import { rememberCall } from './calls.mjs';

const states = new WeakMap();
export function fixtureState(runtime) {
  const state = states.get(runtime);
  if (!state) throw new Error('Runtime was not established by the test fixture');
  return state;
}

/** Low-level tests explicitly assemble recording and a genuine parent R call. */
export function createBoundRuntime({ recorder, ...options } = {}) {
  const invocationRecordings = new Map();
  const recording = recorder ? bindRecording(recorder, { failure: 'propagate' }) : undefined;
  if (recording) {
    const bind = recording.bindInvocation.bind(recording);
    recording.bindInvocation = (setup, parent) => {
      const invocationRecording = bind(setup, parent);
      invocationRecordings.set(setup.identity.contextId, invocationRecording);
      return invocationRecording;
    };
  }
  const runtime = createCoreRuntime({ ...options, ...(recorder ? { clock: recorder.clock, observations: [...(options.observations ?? []), recording] } : {}) });
  const state = { invocationRecordings, recording, recorder, runtime, observe: recorder ? [invocationRecording()] : [] };
  states.set(runtime, state);
  // Kept only on the test fixture to make legacy record assertions explicit.
  Object.defineProperties(runtime, { recording: { value: recording }, recorder: { value: recorder }, record: { get: () => recording?.root } });
  const decorate = (invocation) => {
    Object.defineProperty(invocation, 'record', { get: () => invocationRecordings.get(invocation.context.id)?.record });
    return rememberCall(invocation);
  };
  state.decorate = decorate;
  for (const builder of [runtime.operationInvocationBuilder, runtime.attemptInvocationBuilder]) {
    const create = builder.create.bind(builder);
    builder.create = (parent, request) => decorate(create(parent, { ...request, observation: request.observation ?? state.observe }));
  }
  const createE = runtime.executionInvocationBuilder.create.bind(runtime.executionInvocationBuilder);
  state.createExecution = (parent, input, request) => decorate(createE(parent, input, { ...request, observation: request.observation ?? state.observe }));
  state.beginRuntime = (controls = {}) => {
    let resolve;
    let reject;
    const pending = new Promise((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const call = decorate(runtime.runtimeInvocationBuilder.create(null, { controls, resources: new ResourceBindings({}), observation: recorder ? [invocationRecording({ input: () => null, output: () => null })] : [], work: { maxRounds: 1, execute: () => pending } }));
    const completion = call.run();
    // Some manual lifecycle fixtures deliberately retain a running parent.
    completion.catch(() => {});
    return { call, completion, resolve, reject };
  };
  runtime.executionInvocationBuilder.create = (input, request) => {
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
  runtime.executionInvocationBuilder.submit = (accept, request) => runtime.executionInvocationBuilder.create(accept(), request).run();
  return runtime;
}

export function observeCall(recording, invocation) {
  const record = invocation.record;
  if (!record || recording.recorder.tree.root(record.id) !== recording.root) throw new Error('Execution record does not exist');
  return ExecutionRecordHelper.snapshot(recording.recorder, record.id);
}

/** Record-only ownership fixture; no execution of work is implied. */
export function createRecordScope(recorder) {
  const root = RecordingRootHelper.create(recorder);
  const record = recorder.add(new RuntimeCallRecord(randomUUID(), randomUUID(), { input: null, startedAt: recorder.clock.now() }, root.id));
  InvocationBoundaryRecordHelper.create(recorder, { start: recorder.clock.tick(), scopeId: record.id, callId: record.id }, 'call');
  return record;
}
