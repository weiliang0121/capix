import { checkGeminiReply } from './gemini-contract.js';
import { assertGeminiContinuation } from './gemini-wire.js';
import { assertMessagesContinuation } from './messages-history.js';
import { assertResponsesContinuation } from './responses-wire.js';
import type { ModelOutput, ModelReply, ModelRequest, ModelRequestReservation, ModelToolCall, ModelUsage } from './types.js';
import { checkChatReply } from './chat-contract.js';
import { checkMessagesReply, projectMessagesUsage } from './messages-contract.js';
import { checkResponsesReply } from './responses-contract.js';

export interface ReplyFields {
  readonly id: string;
  readonly model: string;
  readonly output: readonly ModelOutput[];
  readonly termination: ModelReply['termination'];
  readonly usage: ModelUsage | null;
}

interface NativeProtocol {
  readonly assertContinuation?: (request: ModelRequest, reservation?: ModelRequestReservation) => void;
  readonly argumentEncoding: ModelToolCall['arguments']['encoding'];
  readonly check: (native: Record<string, unknown>, fields: ReplyFields, calls: number) => void;
}

/** Offline dispatch for the supported (format, version) pairs. */
const protocols = {
  'chat-completions': { argumentEncoding: 'json-text', check: checkChatReply },
  'anthropic-messages': { argumentEncoding: 'json-value', check: checkMessagesReply, assertContinuation: assertMessagesContinuation },
  'gemini-generate-content': { argumentEncoding: 'json-value', check: checkGeminiReply, assertContinuation: assertGeminiContinuation },
  'openai-responses': { argumentEncoding: 'json-text', check: checkResponsesReply, assertContinuation: assertResponsesContinuation },
} as const satisfies Record<ModelReply['native']['format'], NativeProtocol>;

export function nativeReplyProtocol(native: Record<string, unknown>): NativeProtocol {
  if (native.version !== 1 || typeof native.format !== 'string' || !Object.hasOwn(protocols, native.format)) throw new TypeError('Unsupported model native format or version');
  return protocols[native.format as keyof typeof protocols];
}

/** Read the common counters supported by this reply's reported measurements. */
export function modelReplyUsage(reply: ModelReply): Partial<ModelUsage> | null {
  if (reply.usage !== null) return reply.usage;
  const native = reply.native;
  if (native.format === 'anthropic-messages' && native.partialUsage) return projectMessagesUsage(native.partialUsage);
  return null;
}
