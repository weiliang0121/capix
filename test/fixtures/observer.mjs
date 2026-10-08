import { ExecutionContext, Transcript, TranscriptRangeRef, ResourceBindings, Initializer, bindResources, BindingEnvironment } from '@capix-observer/runtime';

import { acceptExecutionInput, initializeObserver, observeExecution, observerExecutionRequests, observerProviders } from '@capix-observer/service';

const transcripts = new WeakMap();
export const transcriptFor = (input) => transcripts.get(input);
const sources = new WeakMap();
export function captureSource(options) {
  return Object.freeze({ settings: Object.freeze({ ...options.settings }), ...(options.transcript ? { transcriptRange: new TranscriptRangeRef(options.transcript, options.transcript.activeStart, options.transcript.length) } : {}) });
}
export function contextWithSource(input, options) {
  const source = captureSource(options);
  const context = new ExecutionContext(input, options, undefined, options.resourceBinding?.(source));
  sources.set(context, source);
  return context;
}
export function resourceBindingFor(runtime, provider) {
  const model = new Initializer(() => provider);
  const binding = bindResources(observerExecutionRequests, observerProviders);
  return (source) => binding({ ...source, runtime: runtime.context, model, delivery: () => {} });
}
export function bindChild(runtime, definition) {
  return new BindingEnvironment(runtime.operationInvocations, runtime.attemptInvocations).children(definition.requires, [definition], 'operation').get(definition);
}
// Construction metadata is captured only by this test fixture, not exposed by a work Context.
export const sourceFor = (context) => sources.get(context);
export const contextFor = (input, settings = {}) => contextWithSource(input, { settings, transcript: transcriptFor(input) });

export function createInput({ content, history }) {
  const transcript = new Transcript(history);
  const input = acceptExecutionInput(transcript, { messages: [{ role: 'user', content }] });
  transcripts.set(input, transcript);
  return input;
}

export function observeFixture(input, settings, provider, publish, signal) {
  const environment = initializeObserver(provider, transcriptFor(input).snapshot());
  transcripts.set(input, environment.transcript);
  return observeExecution(environment.execution, environment.recording, environment.transcript.current('user'), { settings, signal, transcript: environment.transcript }, publish);
}
