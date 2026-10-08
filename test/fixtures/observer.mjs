import { ExecutionContext, Transcript, ResourceBindings } from '@capix-observer/runtime';

import { acceptExecutionInput, initializeObserver, observeExecution } from '@capix-observer/service';

const transcripts = new WeakMap();
export const transcriptFor = (input) => transcripts.get(input);
const sources = new WeakMap();
export function contextWithSource(input, options) {
  let source;
  const context = new ExecutionContext(input, options, undefined, (value) => {
    source = value;
    return new ResourceBindings({});
  });
  sources.set(context, source);
  return context;
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
