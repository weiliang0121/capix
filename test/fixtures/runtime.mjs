import { ResourceBindings } from './resources.mjs';
import { installCallable } from './driver.mjs';
import { randomUUID } from 'node:crypto';
import { defineScene, CallableInvocationBuilder, bindRecording, invocationRecording } from '@capix/server-runtime';
import { RecordingRootHelper, RuntimeCallRecord, CallableRecord, InvocationBoundaryRecord, InvocationBoundaryRecordHelper, ResourceRecord, TranscriptRecord, MemoryRecord } from '@capix/records';

import { rememberCall } from './calls.mjs';

const states = new WeakMap();
export function fixtureState(runtime) {
  const state = states.get(runtime);
  if (!state) throw new Error('Runtime was not established by the test fixture');
  return state;
}

/** Low-level mechanism tests use one genuine builder and explicit parent calls. */
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
  const capabilities = { ...options, ...(recorder ? { clock: recorder.clock, observations: [...(options.observations ?? []), recording] } : {}) };
  const builder = new CallableInvocationBuilder(capabilities);
  const runtime = installCallable(defineScene()({ run: () => undefined }), { providers: [], source: { capture: () => null }, ...capabilities });
  const state = { invocationRecordings, recording, recorder, runtime, builder, capabilities, observe: recorder ? [invocationRecording()] : [] };
  states.set(runtime, state);
  const decorate = (invocation) => {
    Object.defineProperty(invocation, 'record', { get: () => invocationRecordings.get(invocation.context.id)?.record });
    return rememberCall(invocation);
  };
  state.decorate = decorate;
  const childBuilder = (kind) => ({
    create(parent, request) {
      return decorate(state.builder.create(request.input, { ...request, kind, parent, construction: parent.construction ?? state.construction, observation: request.observation ?? state.observe }));
    },
  });
  const executionBuilder = {};
  // Descriptive fixture adapters preserve old test vocabulary; they all use the same mechanism.
  Object.defineProperties(runtime, {
    runtimeInvocationBuilder: { value: { create: (input, request) => decorate(state.builder.create(input, { ...request, kind: 'scene' })) } },
    executionInvocationBuilder: { value: executionBuilder },
    operationInvocationBuilder: { value: childBuilder('group') },
    attemptInvocationBuilder: { value: childBuilder('node') },
    recording: { value: recording },
    recorder: { value: recorder },
    record: { get: () => recording?.root },
  });
  state.createExecution = (parent, input, request) => {
    request.validate?.();
    const established = request.establish?.() ?? {};
    return decorate(state.builder.create(input, { ...request, ...established, kind: 'group', parent, construction: parent.construction ?? state.construction, controls: request.context, observation: request.observation ?? (recorder ? [invocationRecording({ role: 'conversation-task' })] : []) }));
  };
  state.beginRuntime = (controls = {}) => {
    let resolve;
    let reject;
    const pending = new Promise((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const call = decorate(state.builder.create(null, { kind: 'scene', construction: state.construction, description: { id: runtime.id }, controls, resources: new ResourceBindings({}), observation: recorder ? [invocationRecording({ input: () => null, output: () => null })] : [], work: { execute: () => pending } }));
    const completion = call.run();
    completion.catch(() => {});
    return { call, completion, resolve, reject };
  };
  executionBuilder.create = (input, request) => {
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
  executionBuilder.submit = (accept, request) => executionBuilder.create(accept(), request).run();
  return runtime;
}

export function observeCall(recording, invocation) {
  const record = invocation.record;
  const recorder = recording.recorder;
  if (!(record instanceof CallableRecord) || recorder.tree.root(record.id) !== recording.root) throw new Error('Call record does not exist');
  const descendants = recorder.tree.descendants(record.id);
  const parent = recorder.book.get(record.parentId);
  const rootChildren = parent ? recorder.tree.children(parent.id) : [];
  const calls = [record, ...descendants.filter((item) => item instanceof CallableRecord)].map((item) => item.toJSON());
  const boundaries = [...rootChildren, ...descendants]
    .filter((item) => item instanceof InvocationBoundaryRecord)
    .map((item) => item.toJSON())
    .sort((left, right) => (left.scopeId === right.scopeId ? left.sequence - right.sequence : Date.parse(left.occurredAt) - Date.parse(right.occurredAt)));
  // Convenience subsets are test projections over real callable records, never legacy record instances.
  return {
    execution: record.toJSON(),
    calls,
    rootCall: parent?.toJSON(),
    boundaries,
    operations: calls.slice(1).filter((item) => item.structureKind === 'group'),
    attempts: calls.slice(1).filter((item) => item.structureKind === 'node'),
    events: boundaries.filter((item) => item.callId !== parent?.id),
    runtimeCall: parent?.toJSON(),
    runtimeEvents: boundaries.filter((item) => item.callId === parent?.id),
    resources: [...rootChildren, ...descendants].filter((item) => item instanceof ResourceRecord).map((item) => item.toJSON()),
    transcripts: descendants.filter((item) => item instanceof TranscriptRecord).map((item) => item.toJSON()),
    memories: descendants.filter((item) => item instanceof MemoryRecord).map((item) => item.toJSON()),
  };
}

/** Record-only ownership fixture; no execution of work is implied. */
export function createRecordScope(recorder) {
  const root = RecordingRootHelper.create(recorder);
  const record = recorder.add(new RuntimeCallRecord(randomUUID(), randomUUID(), { input: null, startedAt: recorder.clock.now() }, root.id));
  InvocationBoundaryRecordHelper.create(recorder, { start: recorder.clock.tick(), scopeId: record.id, callId: record.id }, 'call');
  return record;
}
