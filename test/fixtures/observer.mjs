import { ExecutionContext } from '../../dist/server/context/execution.js';
import { Transcript } from '../../dist/server/transcript/transcript.js';
import { acceptExecutionInput } from '../../dist/server/observer/accept.js';
import { initializeObserver } from '../../dist/server/observer/environment.js';
import { observeExecution } from '../../dist/server/observer/observe.js';

const transcripts = new WeakMap();
export const transcriptFor = (input) => transcripts.get(input);
export const contextFor = (input, settings = {}) => new ExecutionContext(input, { settings, transcript: transcriptFor(input) });

export function createInput({ query, history }) {
  const transcript = new Transcript(history);
  const input = acceptExecutionInput(transcript, { messages: [{ role: 'user', content: query }] });
  transcripts.set(input, transcript);
  return input;
}

export function observeFixture(input, settings, provider, publish, signal) {
  const environment = initializeObserver(provider, transcriptFor(input));
  return observeExecution(environment.execution, environment.recorder, input, { settings, signal, transcript: environment.transcript }, publish);
}
