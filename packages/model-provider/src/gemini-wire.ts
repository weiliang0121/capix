import { ProviderError } from './error.js';
import type { GeminiGenerateContentConfiguration, ModelExchange, ModelInputContent, ModelRequest, ToolFeedback } from './types.js';

export type GeminiSource = Pick<GeminiGenerateContentConfiguration, 'bindingId' | 'model'>;

function inputPart(item: ModelInputContent) {
  return item.kind === 'text' ? { text: item.text } : { inlineData: { mimeType: item.mimeType, data: item.data } };
}

function functionResponse(name: string, id: string | undefined, feedback: ToolFeedback) {
  const images = [];
  const content = [];
  for (const item of feedback.content) {
    if (item.kind === 'text') content.push(item);
    else {
      const displayName: string = 'image-' + images.length;
      content.push({ $ref: displayName });
      images.push({ inlineData: { displayName, mimeType: item.mimeType, data: item.data } });
    }
  }
  return { functionResponse: { name, id, response: { [feedback.status === 'ok' ? 'output' : 'error']: content }, parts: images.length ? images : undefined } };
}

function exchangeContents({ reply, feedback }: ModelExchange, binding: GeminiSource) {
  const native = reply.native;
  if (native.format !== 'gemini-generate-content' || native.bindingId !== binding.bindingId || native.model !== binding.model) throw new TypeError('Gemini continuation requires its original model and binding');
  const results = [];
  const byId = new Map(feedback.map((result) => [result.toolCallId, result]));
  const parts = [];
  for (const part of native.parts) {
    const thoughtSignature = part.thoughtSignature;
    if (part.kind === 'signature') parts.push({ thoughtSignature, thought: part.thought });
    else if (part.kind === 'thought') parts.push({ text: part.text, thought: true, thoughtSignature });
    else {
      const item = reply.output[part.index]!;
      if (item.kind === 'text') parts.push({ text: item.text, thought: part.thought, thoughtSignature });
      else {
        if (item.arguments.encoding !== 'json-value') throw new TypeError('Gemini function calls require object input');
        parts.push({ functionCall: { name: item.name, id: part.wireId, args: part.omittedArgs ? undefined : item.arguments.value }, thought: part.thought, thoughtSignature });
        results.push(functionResponse(item.name, part.wireId, byId.get(item.id)!));
      }
    }
  }
  return [{ role: 'model', parts }, ...(results.length ? [{ role: 'user', parts: results }] : [])];
}

function projectHistory(request: ModelRequest, binding: GeminiSource) {
  const system = [];
  const contents: unknown[] = [];
  for (const message of request.messages) {
    const parts = typeof message.content === 'string' ? [{ text: message.content }] : message.content.map(inputPart);
    if (message.role === 'system') {
      if (contents.length) throw new TypeError('Gemini requires system instructions in the leading prefix');
      system.push(...parts);
    } else {
      if (!contents.length && message.role !== 'user') throw new TypeError('Gemini requires an initial user turn');
      contents.push({ role: message.role === 'user' ? 'user' : 'model', parts });
    }
  }
  if (!contents.length) throw new TypeError('Gemini requires a user turn');
  const systemInstruction = system.length ? { parts: system } : undefined;
  const tools = request.tools && [
    {
      functionDeclarations: request.tools.map((tool) => {
        if (!/^[A-Za-z_]/u.test(tool.name) || tool.parameters.type !== 'object') throw new TypeError('Gemini function declarations require a supported name and object schema');
        return { name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters };
      }),
    },
  ];
  for (const exchange of request.exchanges ?? []) contents.push(...exchangeContents(exchange, binding));
  return { systemInstruction, contents, tools };
}

export function assertGeminiContinuation(request: ModelRequest): void {
  const binding = request.exchanges?.[0]?.reply.native;
  if (binding?.format !== 'gemini-generate-content') throw new ProviderError('REQUEST', 'Expected Gemini history');
  try {
    projectHistory(request, binding);
  } catch {
    throw new ProviderError('REQUEST', 'Gemini history requires its original binding and valid conversation prefix');
  }
}

export function encodeGeminiRequest(request: ModelRequest, binding: GeminiSource) {
  const { systemInstruction, contents, tools } = projectHistory(request, binding);
  const choice = request.toolChoice;
  const functionCallingConfig = typeof choice === 'object' ? { mode: 'ANY', allowedFunctionNames: [choice.name] } : choice && { mode: choice === 'required' ? 'ANY' : choice.toUpperCase() };
  const generationConfig = { maxOutputTokens: request.maxTokens, temperature: request.temperature, responseMimeType: request.responseFormat === 'json_object' ? 'application/json' : undefined, responseJsonSchema: request.responseFormat === 'json_object' ? { type: 'object', additionalProperties: true } : undefined };
  return { body: JSON.stringify({ systemInstruction, contents, tools, toolConfig: tools && functionCallingConfig ? { functionCallingConfig } : undefined, generationConfig }), source: binding };
}
