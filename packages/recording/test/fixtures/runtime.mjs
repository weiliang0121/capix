import { ResourceBindings } from './resources.mjs';
import { installCallable } from './driver.mjs';
import { defineScene, CallableInvocationBuilder } from '@weiliang0121/capix-runtime';
import { bindRecording, invocationRecording } from '@weiliang0121/capix-recording';
import { CallableRecord, InvocationBoundaryRecord } from '@weiliang0121/capix-records';

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
  const declarations = recorder ? [invocationRecording()] : [];
  const decorate = (invocation) => {
    Object.defineProperty(invocation, 'record', { get: () => invocationRecordings.get(invocation.context.id)?.record });
    return invocation;
  };
  const childBuilder = (kind) => ({
    create(parent, request) {
      return decorate(builder.create(request.input, { ...request, kind, parent, construction: parent.construction, observation: request.observation ?? declarations }));
    },
  });
  const createExecution = (parent, input, request) => {
    request.validate?.();
    const established = request.establish?.() ?? {};
    return decorate(builder.create(input, { ...request, ...established, kind: 'group', parent, construction: parent.construction, controls: request.context, observation: request.observation ?? (recorder ? [invocationRecording({ role: 'conversation-task' })] : []) }));
  };
  const beginRuntime = (controls = {}) => {
    let resolve;
    let reject;
    const pending = new Promise((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const call = decorate(builder.create(null, { kind: 'scene', description: { id: runtime.id }, controls, resources: new ResourceBindings({}), observation: recorder ? [invocationRecording({ input: () => null, output: () => null })] : [], work: { execute: () => pending } }));
    const completion = call.run();
    completion.catch(() => {});
    return { call, completion, resolve, reject };
  };
  const create = (input, request) => {
    const parent = beginRuntime(request.context);
    let invocation;
    try {
      invocation = createExecution(parent.call, input, request);
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
  return { recording, executionInvocationBuilder: { create }, operationInvocationBuilder: childBuilder('group'), attemptInvocationBuilder: childBuilder('node') };
}

export function callBoundaries(recording, invocation) {
  const record = invocation.record;
  const recorder = recording.recorder;
  if (!(record instanceof CallableRecord) || recorder.tree.root(record.id) !== recording.root) throw new Error('Call record does not exist');
  const entries = [...recorder.tree.children(record.parentId), ...recorder.tree.descendants(record.id)];
  return entries.filter((item) => item instanceof InvocationBoundaryRecord && item.callId !== record.parentId);
}
