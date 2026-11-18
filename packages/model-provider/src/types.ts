export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Provider messages are transport values, not formal Transcript messages. */
export type ModelMessage = { readonly role: 'user'; readonly content: string | readonly ModelInputContent[] } | { readonly role: 'system' | 'assistant'; readonly content: string | readonly ModelTextOutput[] };
/** Fixed image bytes; remote URLs and local paths are not image material. */
export interface ModelImageInput {
  readonly kind: 'image';
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Canonical padded RFC 4648 base64, without a data URL prefix. */
  readonly data: string;
}
export type ModelInputContent = ModelTextOutput | ModelImageInput;
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
  readonly content: readonly ModelInputContent[];
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
  /** Request incremental text/reasoning previews and progress; the complete reply remains authoritative. */
  readonly stream?: boolean;
}
/** Observed stream activity only; never completion, tool execution or reasoning content. */
export interface ModelStreamProgress {
  readonly kind: 'reasoning' | 'text' | 'tool-call';
}
/** Bounded diagnostics from one attempt; neither upstream effects nor billing are inferred. */
export interface ModelAttemptFailure {
  readonly code: 'CONFIGURATION' | 'REQUEST' | 'REQUEST_LIMIT' | 'NETWORK' | 'HTTP' | 'TIMEOUT' | 'RESPONSE_LIMIT' | 'ENVELOPE' | 'CONSUMER' | 'CANCELLED';
  readonly phase: 'connect' | 'http' | 'read' | 'stream' | 'response' | 'consumer' | 'cancelled' | 'timeout';
  readonly status?: number;
}
/** Attempts are numbered within one complete call. Preview consumers must separate attempts. */
export type ModelAttemptEvent = { readonly kind: 'started'; readonly attempt: number } | { readonly kind: 'failed'; readonly attempt: number; readonly failure: ModelAttemptFailure } | { readonly kind: 'retrying'; readonly attempt: number; readonly nextAttempt: number; readonly delayMs: number } | { readonly kind: 'completed'; readonly attempt: number; readonly usage: ModelUsage | null };
/** Explicit permission to repeat generation, not permission to repeat external effects. */
export interface ModelRetryOptions {
  /** Includes the first request. Omit retry entirely to send only once. */
  readonly maxAttempts: number;
  /** Initial backoff in milliseconds; defaults to 1000. */
  readonly delayMs?: number;
  /** Backoff ceiling; defaults to 30000. A larger Retry-After prevents retry. */
  readonly maxDelayMs?: number;
}
export interface ModelControls {
  readonly signal?: AbortSignal;
  /** Synchronous answer text preview only; excludes reasoning and tool arguments. */
  readonly emit?: (delta: string) => void;
  /** Synchronous preview of provider-returned reasoning text; not answer text or execution evidence. */
  readonly emitReasoning?: (delta: string) => void;
  /** Synchronous notification on changes between nonempty, validated stream delta kinds. */
  readonly progress?: (progress: ModelStreamProgress) => void;
  /** Synchronous, per-attempt lifecycle notification. A consumer failure stops all retries. */
  readonly attempt?: (event: ModelAttemptEvent) => void;
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
  /** Effective provider send budgets; custom providers may omit these. */
  readonly limits?: { readonly maxRequestBytes: number; readonly maxWireRequestBytes: number };
}
export interface ChatCompletionsConfiguration {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  /** Common request send budget; defaults to 2 MiB, up to maximumModelRequestBytes. */
  readonly maxRequestBytes?: number;
  /** Encoded HTTP body send budget; defaults to 2 MiB, up to maximumModelWireRequestBytes. */
  readonly maxWireRequestBytes?: number;
  /** Transport budget may be lower than the fixed 2 MiB public value limit. */
  readonly maxResponseBytes?: number;
  readonly thinking?: 'enabled' | 'disabled';
  /** Opt-in retries for generation-only endpoints; timeoutMs still bounds the whole call. */
  readonly retry?: ModelRetryOptions;
  readonly fetch?: typeof fetch;
}
