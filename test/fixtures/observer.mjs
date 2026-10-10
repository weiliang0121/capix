import { definitionResources, ExecutionContext, Transcript, TranscriptRangeRef, ResourceBindings, Initializer, bindResources, BindingEnvironment, Memories, SelectionUsage } from '@capix/server-runtime';

import { acceptConversationInput, initializeObserver, observeExecution, conversationExecutionRequests, conversationProviders } from '@capix/observer-service';

const transcripts = new WeakMap();
export const transcriptFor = (input) => transcripts.get(input);
const sources = new WeakMap();
export function captureSource(options) {
  return Object.freeze({ settings: Object.freeze({ ...options.settings }), ...(options.transcript ? { transcriptRange: new TranscriptRangeRef(options.transcript, options.transcript.activeStart, options.transcript.length) } : {}) });
}
export function contextWithSource(input, options, parent) {
  const source = captureSource(options);
  const context = new ExecutionContext(input, options, undefined, options.resourceBinding?.(source), parent);
  sources.set(context, source);
  return context;
}
export function resourceBindingFor(runtime, provider, provided) {
  const model = new Initializer(() => provider);
  const binding = bindResources(conversationExecutionRequests, conversationProviders);
  const worlds = new WeakMap();
  return (source) => {
    const transcript = source.transcriptRange?.transcript ?? new Transcript();
    let entities = provided ?? worlds.get(transcript);
    if (!entities) {
      entities = { transcript, memories: new Memories(transcript, { observation: runtime.recording?.memory }), selectionUsage: new SelectionUsage() };
      worlds.set(transcript, entities);
    }
    return binding({ ...source, ...entities, model, delivery: () => {} });
  };
}
export function bindChild(runtime, definition) {
  const environment = new BindingEnvironment(runtime.executionInvocationBuilder, runtime.operationInvocationBuilder, runtime.attemptInvocationBuilder, runtime.recording?.provides);
  return environment.children(environment.resources(definition), [definition], 'operation').get(definition);
}
// Construction metadata is captured only by this test fixture, not exposed by a work Context.
export const sourceFor = (context) => sources.get(context);
export const contextFor = (input, settings = {}) => contextWithSource(input, { settings, transcript: transcriptFor(input) });

export function createInput({ content, history }) {
  const transcript = new Transcript(history);
  const input = acceptConversationInput(transcript, { messages: [{ role: 'user', content }] });
  transcripts.set(input, transcript);
  return input;
}

export function observeFixture(input, settings, provider, publish, signal) {
  const environment = initializeObserver(provider, transcriptFor(input).snapshot().slice(0, -1));
  transcripts.set(input, environment.transcript);
  return observeExecution(environment.runtime, environment.recording, { messages: [input] }, { settings, signal }, publish);
}

export function resourceFact(snapshot, access) {
  return snapshot.resources.find((fact) => fact.parentId === snapshot.execution.id && fact.access === access && fact.phase === 'available')?.value;
}
