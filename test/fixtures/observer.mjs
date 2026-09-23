import { Transcript } from '../../dist/server/transcript/transcript.js';
import { acceptExecutionInput } from '../../dist/server/observer/accept.js';
import { initializeObserver } from '../../dist/server/observer/environment.js';
import { observeExecution } from '../../dist/server/observer/observe.js';

export function createInput({ query, history }) {
  const transcript = new Transcript(history);
  return acceptExecutionInput(transcript, { messages: [{ role: 'user', content: query }] });
}

export function observeFixture(input, settings, provider, publish, signal) {
  const environment = initializeObserver(provider, input.transcript);
  return observeExecution(environment.execution, environment.recorder, input, { settings, signal, transcript: environment.transcript }, publish);
}
