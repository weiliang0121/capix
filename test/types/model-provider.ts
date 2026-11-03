import { ChatCompletionsProvider, ProviderError } from '@capix/model-provider';
import type { TextModel } from '@capix/conversation-service';

const provider = new ChatCompletionsProvider({ endpoint: 'https://provider.example/chat/completions', apiKey: 'fixture', model: 'fixture-model', timeoutMs: 1000, maxResponseBytes: 4096, thinking: 'disabled', fetch });
const request = { messages: [{ role: 'user', content: 'Hello' }] } as const;
const result = await provider.complete(request, { signal: new AbortController().signal });
const text: string = result.text;
const reason: string = result.finishReason;
const usage: number | undefined = result.usage?.totalTokens;
void [text, reason, usage];

// The provider envelope is intentionally not the conversation's text result.
// The host's explicit adapter decides whether this completion can be accepted.
const model: TextModel = {
  async generate(messages, { signal }) {
    const reply = await provider.complete({ messages }, { signal });
    if (reply.finishReason !== 'stop') throw new Error('Model completion was not finished');
    return reply.text;
  },
};
void model;

await provider.complete({ messages: [{ role: 'system', content: 'Choose one registered intent.' }, ...request.messages], responseFormat: 'json_object', maxTokens: 256, temperature: 0 });
// @ts-expect-error A provider configuration must identify its model.
new ChatCompletionsProvider({ endpoint: 'https://provider.example/chat/completions', apiKey: 'fixture' });
// @ts-expect-error API keys are strings, not token count settings.
new ChatCompletionsProvider({ endpoint: 'https://provider.example/chat/completions', apiKey: 100, model: 'fixture' });
// @ts-expect-error Arbitrary runtime roles are not a text-completion message contract.
provider.complete({ messages: [{ role: 'resource', content: 'x' }] });
// @ts-expect-error The package does not pretend to support provider tools.
provider.complete({ messages: [{ role: 'tool', content: 'x' }] });
// @ts-expect-error Response format is an explicit supported choice, not a schema DSL.
provider.complete({ messages: request.messages, responseFormat: { type: 'json_schema' } });
// @ts-expect-error Input content is text rather than arbitrary structured data.
provider.complete({ messages: [{ role: 'user', content: { prompt: 'hello' } }] });
// @ts-expect-error The result is a completion envelope, not a parsed business decision.
result.selected;
const streamed = await provider.complete(
  { ...request, stream: true },
  {
    emit: (delta) => {
      const text: string = delta;
      void text;
    },
  },
);
const finalText: string = streamed.text;
const finalReason: string = streamed.finishReason;
void [finalText, finalReason];
// @ts-expect-error A stream request is an explicit boolean, not a receiver or transport label.
provider.complete({ ...request, stream: 'sse' });
// @ts-expect-error Preview deltas are strings, not final envelopes or structured tool output.
provider.complete({ ...request, stream: true }, { emit: (_delta: { text: string }) => {} });

declare const error: ProviderError;
const code: string = error.code;
const status: number | undefined = error.status;
void [code, status];
