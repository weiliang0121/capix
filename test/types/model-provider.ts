import { ChatCompletionsProvider, ProviderError, modelReplyText, requireModelReply, requireModelRequest, type ModelToolCall, type ToolResult, type ModelProvider, type ModelRequestInspection } from '@capix/model-provider';
import { createConversationRunner } from '@capix/conversation-service';
import { Transcript } from '@capix/transcript';

const provider = new ChatCompletionsProvider({ endpoint: 'https://provider.example/chat/completions', apiKey: 'fixture', model: 'fixture-model', timeoutMs: 1000, maxResponseBytes: 4096, thinking: 'disabled', fetch });
const request = { messages: [{ role: 'user', content: 'Hello' }] } as const;
const inspection: ModelRequestInspection = provider.inspectRequest(request);
const wireBytes: number = inspection.wireBytes;
const requestBytes: number = inspection.requestBytes;
void [wireBytes, requestBytes];
// @ts-expect-error Inspection is a frozen measurement, not a writable allowance.
inspection.wireBytes = 1;
// @ts-expect-error Inspection does not expose transport credentials or request bodies.
inspection.body;
// @ts-expect-error Request inspection accepts the same protocol as complete.
provider.inspectRequest({ messages: [{ role: 'tool', content: 'bypass' }] });
declare const injected: ModelProvider;
// @ts-expect-error Generic providers may not support transport inspection.
injected.inspectRequest(request);
if (injected.inspectRequest) {
  const checked: ModelRequestInspection = injected.inspectRequest(request);
  void checked;
}
const completeOnly: ModelProvider = { complete: (request, controls) => provider.complete(request, controls) };
void completeOnly;
const result = await provider.complete(request, { signal: new AbortController().signal });
const text: string = modelReplyText(result);
const reason: string = result.termination.reason;
const usage: number | undefined = result.usage?.totalTokens;
void [text, reason, usage];

// The conversation service consumes the provider directly and accepts its complete reply.
const conversation = createConversationRunner(new Transcript(), provider);
const answer: Promise<string> = conversation.run('Hello');
void answer;

await provider.complete({ messages: [{ role: 'system', content: 'Choose one registered intent.' }, ...request.messages], responseFormat: 'json_object', maxTokens: 256, temperature: 0 });
// @ts-expect-error A provider configuration must identify its model.
new ChatCompletionsProvider({ endpoint: 'https://provider.example/chat/completions', apiKey: 'fixture' });
// @ts-expect-error API keys are strings, not token count settings.
new ChatCompletionsProvider({ endpoint: 'https://provider.example/chat/completions', apiKey: 100, model: 'fixture' });
// @ts-expect-error Arbitrary runtime roles are not a text-completion message contract.
provider.complete({ messages: [{ role: 'resource', content: 'x' }] });
// @ts-expect-error Raw tool messages cannot bypass the closed exchange contract.
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
const finalText: string = modelReplyText(streamed);
const finalReason: string = streamed.termination.reason;
void [finalText, finalReason];
// @ts-expect-error A stream request is an explicit boolean, not a receiver or transport label.
provider.complete({ ...request, stream: 'sse' });
// @ts-expect-error Preview deltas are strings, not final envelopes or structured tool output.
provider.complete({ ...request, stream: true }, { emit: (_delta: { text: string }) => {} });

declare const error: ProviderError;
const code: string = error.code;
const status: number | undefined = error.status;
void [code, status];

const toolRequest = requireModelRequest({ messages: request.messages, tools: [{ name: 'lookup', description: 'Find a value', parameters: { type: 'object' } }], toolChoice: { name: 'lookup' } });
await provider.complete(toolRequest);
const restored = requireModelReply(result);
const sameReply: typeof result = restored;
void sameReply;
declare const toolCall: ModelToolCall;
const args: string = toolCall.arguments.text;
void args;
// @ts-expect-error Tool arguments are unparsed JSON text, not arbitrary decoded values.
const invalidArgs: { path: string } = toolCall.arguments;
// @ts-expect-error Old duplicate text field no longer exists.
result.text;
// @ts-expect-error Old duplicate completion reason field no longer exists.
result.finishReason;
// @ts-expect-error Author feedback status is explicit.
const invalidResult: ToolResult = { status: 'maybe', content: [] };
// @ts-expect-error Tool parameters are JSON objects, not functions or capabilities.
provider.complete({ messages: request.messages, tools: [{ name: 'x', description: 'x', parameters: () => ({}) }] });
