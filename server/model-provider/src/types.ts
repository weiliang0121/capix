export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Provider messages are transport values, not formal Transcript messages. */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}
export interface ModelTextOutput {
  readonly kind: 'text';
  readonly text: string;
}
export interface ModelToolCall {
  readonly kind: 'tool-call';
  readonly id: string;
  readonly name: string;
  /** Kept verbatim. Parsing and validating tool arguments belongs to the caller. */
  readonly arguments: { readonly encoding: 'json-text'; readonly text: string };
}
export type ModelOutput = ModelTextOutput | ModelToolCall;
export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly promptCacheHitTokens?: number;
  readonly promptCacheMissTokens?: number;
}
export interface ModelReply {
  readonly formatVersion: 1;
  readonly id: string;
  readonly model: string;
  readonly output: readonly ModelOutput[];
  /** Transport termination is not business acceptance. Unknown reasons remain incomplete. */
  readonly termination: { readonly kind: 'completed' | 'incomplete' | 'refused'; readonly reason: string };
  readonly usage: ModelUsage | null;
  /** Only protocol data not represented by the common fields. Never a second reply. */
  readonly native: { readonly format: 'chat-completions'; readonly version: 1; readonly reasoningContent?: string };
}
export interface ToolResult {
  readonly status: 'ok' | 'error';
  readonly content: readonly ModelTextOutput[];
}
export interface ToolFeedback extends ToolResult {
  readonly toolCallId: string;
}
export interface ModelExchange {
  readonly reply: ModelReply;
  readonly feedback: readonly ToolFeedback[];
}
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}
export type ModelToolChoice = 'auto' | 'none' | 'required' | { readonly name: string };
export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  /** Closed exchanges appended in order after the fixed message prefix. */
  readonly exchanges?: readonly ModelExchange[];
  readonly tools?: readonly ModelTool[];
  readonly toolChoice?: ModelToolChoice;
  readonly maxTokens?: number;
  readonly responseFormat?: 'text' | 'json_object';
  readonly temperature?: number;
  /** Request incremental text previews; the complete reply remains authoritative. */
  readonly stream?: boolean;
}
export interface ModelControls {
  readonly signal?: AbortSignal;
  /** Synchronous text preview only. Tools/reasoning are available in the complete reply. */
  readonly emit?: (delta: string) => void;
}
/** Small injectable capability. Prompts, schemas and result acceptance belong to its consumer. */
export interface ModelProvider {
  /** Validate and measure a request without sending it; availability depends on the provider. */
  inspectRequest?(request: ModelRequest): ModelRequestInspection;
  complete(request: ModelRequest, controls?: ModelControls): Promise<ModelReply>;
}

export interface ModelRequestInspection {
  /** UTF-8 bytes of the validated common request's JSON representation. */
  readonly requestBytes: number;
  /** UTF-8 bytes of the actual HTTP body, including fixed provider configuration. */
  readonly wireBytes: number;
}
export interface ChatCompletionsConfiguration {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  /** Transport budget may be lower than the fixed 2 MiB public value limit. */
  readonly maxResponseBytes?: number;
  readonly thinking?: 'enabled' | 'disabled';
  readonly fetch?: typeof fetch;
}
