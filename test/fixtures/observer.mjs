import { ExecutionContext, Transcript } from '@capix-observer/runtime';

import { acceptExecutionInput, initializeObserver, observeExecution } from '@capix-observer/service';

const transcripts = new WeakMap();
export const transcriptFor = (input) => transcripts.get(input);
export const contextFor = (input, settings = {}) => new ExecutionContext(input, { settings, transcript: transcriptFor(input) });

export function createInput({ content, history }) {
  const transcript = new Transcript(history);
  const input = acceptExecutionInput(transcript, { messages: [{ role: 'user', content }] });
  transcripts.set(input, transcript);
  return input;
}

export function observeFixture(input, settings, provider, publish, signal) {
  const environment = initializeObserver(provider, transcriptFor(input).snapshot());
  transcripts.set(input, environment.transcript);
  return observeExecution(environment.execution, environment.recorder, environment.transcript.current('user'), { settings, signal, transcript: environment.transcript }, publish);
}
