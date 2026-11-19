import type { AnthropicMessagesProvider, ChatCompletionsProvider, OpenAIResponsesProvider, GeminiGenerateContentProvider, JsonObject, ModelReply, ModelRequest } from '@weiliang0121/capix-model-provider';

async function check(chat: ChatCompletionsProvider, messages: AnthropicMessagesProvider, responses: OpenAIResponsesProvider, gemini: GeminiGenerateContentProvider, request: ModelRequest, generic: ModelReply) {
  const chatReply = await chat.complete(request);
  chatReply.native.reasoningContent satisfies string | undefined;
  for (const item of chatReply.output) if (item.kind === 'tool-call') item.arguments.text satisfies string;

  const messagesReply = await messages.complete(request);
  messagesReply.native.format satisfies 'anthropic-messages';
  for (const item of messagesReply.output) if (item.kind === 'tool-call') item.arguments.value satisfies JsonObject;

  const responsesReply = await responses.complete(request);
  responsesReply.native.format satisfies 'openai-responses';
  for (const item of responsesReply.output) if (item.kind === 'tool-call') item.arguments.text satisfies string;
  for (const item of responsesReply.native.items) {
    if (item.kind === 'function_call') item.index satisfies number;
    if (item.kind === 'reasoning') item.summary satisfies readonly string[];
    if (item.kind === 'message') item.phase satisfies 'commentary' | 'final_answer' | undefined;
  }

  const geminiReply = await gemini.complete(request);
  geminiReply.native.format satisfies 'gemini-generate-content';
  geminiReply.native.idSource satisfies 'local' | undefined;
  geminiReply.native.modelSource satisfies 'configured' | undefined;
  for (const item of geminiReply.output) if (item.kind === 'tool-call') item.arguments.value satisfies JsonObject;
  for (const part of geminiReply.native.parts) {
    if (part.kind === 'output') part.wireId satisfies string | undefined;
    if (part.kind === 'thought') part.text satisfies string;
    part.thoughtSignature satisfies string | undefined;
  }

  // @ts-expect-error Generic consumers must check the native format.
  generic.native.reasoningContent;
  if (generic.native.format === 'anthropic-messages') generic.native.blocks;
  for (const item of generic.output) {
    if (item.kind !== 'tool-call') continue;
    // @ts-expect-error Generic callers must discriminate the argument encoding.
    item.arguments.text;
    if (item.arguments.encoding === 'json-text') item.arguments.text satisfies string;
    else item.arguments.value satisfies JsonObject;
  }
}
void check;
