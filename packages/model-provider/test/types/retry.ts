import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import type { ModelAttemptEvent, ModelAttemptFailure, ModelControls, ModelRetryOptions } from '@weiliang0121/capix-model-provider';

const retry: ModelRetryOptions = { maxAttempts: 3, delayMs: 1000, maxDelayMs: 30000 };
const failure: ModelAttemptFailure = { code: 'NETWORK', phase: 'read' };
const controls: ModelControls = {
  attempt(event) {
    if (event.kind === 'retrying') {
      const next: number = event.nextAttempt;
      const delay: number = event.delayMs;
      void [next, delay];
    } else if (event.kind === 'failed') {
      const diagnostic: ModelAttemptFailure = event.failure;
      void diagnostic;
    } else if (event.kind === 'completed') {
      const total: number | undefined = event.usage?.totalTokens;
      void total;
    }
    // @ts-expect-error Attempt facts cannot be changed by consumers.
    event.attempt = 2;
    // @ts-expect-error No provider response body is exposed in attempt facts.
    event.body;
  },
};
new ChatCompletionsProvider({ endpoint: 'https://fixture.invalid/chat/completions', apiKey: 'offline', model: 'fixture', retry });
// @ts-expect-error There is no unbounded retry mode.
const unlimited: ModelRetryOptions = { forever: true };
// @ts-expect-error A transport-started event cannot claim a complete reply.
const invalid: ModelAttemptEvent = { kind: 'started', attempt: 1, usage: null };
void [retry, failure, controls, unlimited, invalid];
