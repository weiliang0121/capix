import { createHash } from 'node:crypto';
import { ModelProtocolIssue, ProviderError } from './error.js';
import { identity } from './value.js';
import type { ModelExchange, ModelInputContent, ModelRequest, ModelRequestReservation, OpenAIResponsesReply } from './types.js';

type ResponsesBinding = Pick<OpenAIResponsesReply['native'], 'model' | 'bindingId' | 'continuation'>;
export interface ResponsesSource extends ResponsesBinding {
  previousResponseId: string | null;
  prefixSha256: string;
}

function inputPart(item: ModelInputContent) {
  return item.kind === 'text' ? { type: 'input_text', text: item.text } : { type: 'input_image', image_url: `data:${item.mimeType};base64,${item.data}`, detail: 'auto' };
}

/** Responses echoes this identity in FunctionCallOutput, whose call_id allows 1–64 characters. */
export function checkResponsesCallId(id: unknown): void {
  identity(id);
  if (Array.from(id).length > 64) throw new TypeError('Responses function call ID exceeds 64 characters');
}

function outputItems(reply: OpenAIResponsesReply, projection: 'proof-v1' | 'replay') {
  return reply.native.items.map((item) => {
    if (item.kind === 'function_call') {
      const call = reply.output[item.index];
      if (call?.kind !== 'tool-call') throw new TypeError('Invalid Responses function layout');
      return { type: item.kind, id: item.id, status: item.status, call_id: call.id, name: call.name, arguments: call.arguments.text };
    }
    if (item.kind === 'reasoning') return { type: item.kind, id: item.id, status: item.status, summary: item.summary.map((text) => ({ type: 'summary_text', text })), content: item.content?.map((text) => ({ type: 'reasoning_text', text })), encrypted_content: item.encryptedContent };
    const content = item.content.map((part) => {
      if (part.kind === 'refusal') return { type: part.kind, refusal: part.refusal };
      const text = reply.output[part.index];
      if (text?.kind !== 'text') throw new TypeError('Invalid Responses message layout');
      // The persisted v1 digest predates the explicit empty logprobs array on the wire.
      return { type: part.kind, text: text.text, annotations: [], logprobs: projection === 'replay' ? [] : undefined };
    });
    return { type: item.kind, id: item.id, status: item.status, role: 'assistant', phase: item.phase, content };
  });
}

function feedbackItems({ reply, feedback }: ModelExchange) {
  const results = new Map(feedback.map((result) => [result.toolCallId, result]));
  return reply.output
    .filter((item) => item.kind === 'tool-call')
    .map((call) => {
      const result = results.get(call.id)!;
      // Function outputs have no native error flag. Put status in a separate,
      // fixed text part so successful result text cannot impersonate an error.
      return { type: 'function_call_output', call_id: call.id, output: [{ type: 'input_text', text: JSON.stringify({ status: result.status }) }, ...result.content.map(inputPart)] };
    });
}

/** Only a stored response claims that its original input is still the current input. */
export function responsesPrefixProof(requestDigest: string, reply: OpenAIResponsesReply): string {
  const { bindingId, model, continuation, previousResponseId } = reply.native;
  return createHash('sha256')
    .update('capix.openai-responses.reply.v1\n')
    .update(JSON.stringify([bindingId, model, continuation, previousResponseId, continuation === 'previous-response-id' ? requestDigest : null, reply.id, reply.model, [reply.termination.kind, reply.termination.reason], outputItems(reply, 'proof-v1')]))
    .digest('hex');
}

function isResponses(reply: ModelExchange['reply']): reply is OpenAIResponsesReply {
  return reply.native.format === 'openai-responses';
}

function addHistoryIdentity(ids: Set<string>, id: string): void {
  if (ids.has(id)) throw new TypeError('Responses history repeats an identity within the same namespace');
  ids.add(id);
}

/** Reconstruct the logical remote conversation at every handle from fixed local facts. */
function projectHistory(request: ModelRequest, binding: ResponsesBinding) {
  const stored = binding.continuation === 'previous-response-id';
  let input: unknown[] = request.messages.map((message) => ({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(inputPart) }));
  const prefix = createHash('sha256').update('capix.openai-responses.input.v1\n');
  const append = (item: unknown) => prefix.update(JSON.stringify(item)).update('\n');
  if (stored) for (const item of input) append(item);
  let previousResponseId: string | null = null;
  const responseIds = new Set<string>();
  const itemIds = new Set<string>();
  const callIds = new Set<string>();
  for (const exchange of request.exchanges ?? []) {
    const reply = exchange.reply;
    if (!isResponses(reply)) throw new TypeError('Responses requires its original native history');
    const native = reply.native;
    if (native.bindingId !== binding.bindingId || native.model !== binding.model || native.continuation !== binding.continuation || native.previousResponseId !== previousResponseId) throw new TypeError('Responses history has a different deployment, strategy or predecessor');
    addHistoryIdentity(responseIds, reply.id);
    for (const item of native.items) addHistoryIdentity(itemIds, item.id);
    for (const item of reply.output) {
      if (item.kind !== 'tool-call') continue;
      checkResponsesCallId(item.id);
      addHistoryIdentity(callIds, item.id);
    }
    if (native.prefixSha256 !== responsesPrefixProof(prefix.copy().digest('hex'), reply)) throw new TypeError('Responses history disagrees with its original reply');
    const feedback = feedbackItems(exchange);
    if (stored) {
      append(native.prefixSha256);
      for (const item of feedback) append(item);
      previousResponseId = reply.id;
      input = feedback;
    } else {
      if (native.items.some((item) => item.kind === 'reasoning' && !item.encryptedContent)) throw new ModelProtocolIssue('REQUEST', 'missing-reasoning-ciphertext');
      input.push(...outputItems(reply, 'replay'), ...feedback);
    }
  }
  return { input, source: { ...binding, previousResponseId, prefixSha256: prefix.digest('hex') } };
}

export function assertResponsesReservation(request: ModelRequest, reservation: ModelRequestReservation): void {
  const history = request.exchanges ?? [];
  const last = history.at(-1)?.reply.native;
  if (last?.format !== 'openai-responses' || last.continuation !== 'previous-response-id') return;
  if (reservation.mutableContext || reservation.contextGrowthBytes > 0) throw new ProviderError('REQUEST', 'Dynamic context can change a stored Responses prefix');
  if (reservation.imageOmissionBytes && history.slice(0, -1).some(({ feedback }, index) => (reservation.imageOmissionByExchange?.[index] ?? 1) > 0 && feedback.some((value) => value.content.some((part) => part.kind === 'image')))) throw new ProviderError('REQUEST', 'Image retention can change a stored Responses prefix');
}

export function assertResponsesContinuation(request: ModelRequest, reservation?: ModelRequestReservation): void {
  const admitted = request.exchanges?.find(({ reply }) => isResponses(reply))?.reply.native;
  if (admitted?.format !== 'openai-responses') return;
  try {
    projectHistory(request, admitted);
  } catch (error) {
    if (error instanceof ModelProtocolIssue) throw error.at('openai-responses', 'request');
    throw new ProviderError('REQUEST', 'Responses continuation requires original reply material, binding and a matching stored prefix');
  }
  if (reservation) assertResponsesReservation(request, reservation);
}

export function encodeResponsesRequest(request: ModelRequest, binding: ResponsesBinding) {
  if (request.maxTokens !== undefined && request.maxTokens < 16) throw new TypeError('Responses requires at least 16 output tokens');
  const { input, source } = projectHistory(request, binding);
  const store = binding.continuation === 'previous-response-id';
  const tools = request.tools?.map((tool) => {
    if (tool.name.length > 64 || tool.parameters.type !== 'object') throw new TypeError('Responses function tools require a name up to 64 characters and an object schema');
    return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
  });
  const choice = request.toolChoice;
  const body = JSON.stringify({ model: binding.model, input, store, previous_response_id: source.previousResponseId ?? undefined, include: store ? undefined : ['reasoning.encrypted_content'], stream: request.stream === true, tools, tool_choice: typeof choice === 'object' ? { type: 'function', name: choice.name } : choice, max_output_tokens: request.maxTokens, temperature: request.temperature, text: request.responseFormat === undefined ? undefined : { format: { type: request.responseFormat } } });
  return { body, source };
}
