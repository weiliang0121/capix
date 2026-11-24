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
interface ToolCall<Arguments> {
  readonly kind: 'tool-call';
  readonly id: string;
  readonly name: string;
  readonly arguments: Arguments;
}
type JsonTextToolCall = ToolCall<{ readonly encoding: 'json-text'; readonly text: string }>;
type JsonValueToolCall = ToolCall<{ readonly encoding: 'json-value'; readonly value: JsonObject }>;
export type ModelToolCall = JsonTextToolCall | JsonValueToolCall;
export type ChatCompletionsToolCall = JsonTextToolCall;
export type GeminiGenerateContentToolCall = JsonValueToolCall;
export type AnthropicMessagesToolCall = JsonValueToolCall;
export type OpenAIResponsesToolCall = JsonTextToolCall;
export type ModelOutput = ModelTextOutput | ModelToolCall;
export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly promptCacheHitTokens?: number;
  readonly promptCacheMissTokens?: number;
  /** Reported input used to create a prompt cache entry, already included in promptTokens. */
  readonly promptCacheWriteTokens?: number;
}
interface Reply<Call extends ModelToolCall, Native> {
  readonly formatVersion: 1;
  readonly id: string;
  readonly model: string;
  readonly output: readonly (ModelTextOutput | Call)[];
  /** Transport termination is not business acceptance. Unknown reasons remain incomplete. */
  readonly termination: { readonly kind: 'completed' | 'incomplete' | 'refused'; readonly reason: string };
  readonly usage: ModelUsage | null;
  /** Only protocol data not represented by the common fields. Never a second reply. */
  readonly native: Native;
}
export type ChatCompletionsReply = Reply<ChatCompletionsToolCall, { readonly format: 'chat-completions'; readonly version: 1; readonly reasoningContent?: string }>;
/** Output references cover each public text or call in ascending order. */
export type AnthropicMessagesBlock = { readonly kind: 'output'; readonly index: number } | { readonly kind: 'thinking'; readonly thinking: string; readonly signature: string } | { readonly kind: 'redacted_thinking'; readonly data: string };
/** Final Messages counters available when the endpoint supplied only part of its usage. */
export type AnthropicMessagesUsageCounts = Readonly<Partial<Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens', number>>>;
export type AnthropicMessagesReply = Reply<AnthropicMessagesToolCall, { readonly format: 'anthropic-messages'; readonly version: 1; readonly bindingId: string; readonly model: string; readonly anthropicVersion: string; readonly partialUsage?: AnthropicMessagesUsageCounts; readonly prefixSha256?: string; readonly blocks: readonly AnthropicMessagesBlock[] }>;
type ResponsesItemStatus = 'in_progress' | 'completed' | 'incomplete';
/** Each public output appears exactly once in item order. A function item's id differs from the public call id. */
export type OpenAIResponsesItem = { readonly kind: 'message'; readonly id: string; readonly status: ResponsesItemStatus; readonly phase?: 'commentary' | 'final_answer'; readonly content: readonly ({ readonly kind: 'output_text'; readonly index: number } | { readonly kind: 'refusal'; readonly refusal: string })[] } | { readonly kind: 'function_call'; readonly id: string; readonly status?: ResponsesItemStatus; readonly index: number } | { readonly kind: 'reasoning'; readonly id: string; readonly status?: ResponsesItemStatus; readonly summary: readonly string[]; readonly content?: readonly string[]; readonly encryptedContent?: string };
export type OpenAIResponsesReply = Reply<OpenAIResponsesToolCall, { readonly format: 'openai-responses'; readonly version: 1; readonly bindingId: string; readonly model: string; readonly continuation: 'replay' | 'previous-response-id'; readonly previousResponseId: string | null; readonly prefixSha256: string; readonly items: readonly OpenAIResponsesItem[] }>;
/**
 * The ordered model turn. Output parts reference the public value once.
 * wireId is Gemini's optional function call ID, independent of the public feedback slot.
 */
export type GeminiGenerateContentPart = ({ readonly kind: 'output'; readonly index: number; readonly wireId?: string; readonly omittedArgs?: true; readonly thought?: false } | { readonly kind: 'thought'; readonly text: string } | { readonly kind: 'signature'; readonly thoughtSignature: string; readonly thought?: boolean }) & { readonly thoughtSignature?: string };
export type GeminiGenerateContentReply = Reply<GeminiGenerateContentToolCall, { readonly format: 'gemini-generate-content'; readonly version: 1; readonly bindingId: string; readonly model: string; readonly idSource?: 'local'; readonly modelSource?: 'configured'; readonly partsSha256?: string; readonly promptBlocked?: true; readonly parts: readonly GeminiGenerateContentPart[] }>;
export type ModelReply = ChatCompletionsReply | AnthropicMessagesReply | OpenAIResponsesReply | GeminiGenerateContentReply;
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
  /** Ordered messages after all closed exchanges. Supported by Chat Completions. */
  readonly trailingMessages?: readonly ModelMessage[];
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
/** Static categories only. No raw upstream fields, values, or event names are retained. */
export interface ModelProtocolDiagnostic {
  readonly protocol: ModelReply['native']['format'];
  readonly phase: 'request' | 'response' | 'stream';
  readonly reason: 'invalid-request' | 'unsupported-trailing-messages' | 'invalid-json' | 'invalid-utf8' | 'missing-body' | 'unexpected-content-type' | 'invalid-envelope' | 'missing-response-id' | 'invalid-response-id' | 'missing-model' | 'invalid-model' | 'invalid-candidate' | 'invalid-part' | 'invalid-usage' | 'missing-terminal' | 'truncated-event' | 'inconsistent-stream-identity' | 'event-order' | 'invalid-event' | 'unsupported-response-format' | 'missing-thinking-signature' | 'invalid-block' | 'unsupported-block' | 'missing-reasoning-ciphertext' | 'store-mismatch' | 'predecessor-mismatch';
}
/** Bounded diagnostics from one attempt; neither upstream effects nor billing are inferred. */
export interface ModelAttemptFailure {
  readonly code: 'CONFIGURATION' | 'REQUEST' | 'REQUEST_LIMIT' | 'NETWORK' | 'HTTP' | 'TIMEOUT' | 'RESPONSE_LIMIT' | 'ENVELOPE' | 'CONSUMER' | 'CANCELLED';
  readonly phase: 'connect' | 'http' | 'read' | 'stream' | 'response' | 'consumer' | 'cancelled' | 'timeout';
  readonly status?: number;
  readonly diagnostic?: ModelProtocolDiagnostic;
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
  /** Protocol-specific upper bound for a completed request with the indicated feedback and context growth. */
  reserveWireBytes?(request: ModelRequest, reservation: ModelRequestReservation): number;
  complete(request: ModelRequest, controls?: ModelControls): Promise<ModelReply>;
}

export interface ModelRequestReservation {
  /** Size of each complete common feedback value replacing a slot in the request. */
  readonly feedback: readonly { readonly toolCallId: string; readonly maxBytes: number }[];
  /** Maximum increase in the common request's UTF-8 JSON bytes for one optional prefix message, including its array separator on insertion. */
  readonly contextGrowthBytes: number;
  /** Set when that message can be replaced or removed even at zero byte growth. */
  readonly mutableContext?: true;
  /** With mutableContext, only the final user string in messages may change to another user string or be removed. The trailingMessages array is fixed. */
  readonly contextShape?: 'trailing-user-text';
  /** Sum of the full common JSON byte budgets of possible image omission markers, before subtracting any displaced image bytes. */
  readonly imageOmissionBytes?: number;
  /** Per-exchange share of the image omission allowance, in request order. */
  readonly imageOmissionByExchange?: readonly number[];
}
export interface ModelRequestInspection {
  /** UTF-8 bytes of the validated common request's JSON representation. */
  readonly requestBytes: number;
  /** UTF-8 bytes of the actual HTTP body, including fixed provider configuration. */
  readonly wireBytes: number;
  /** Effective provider send budgets; custom providers may omit these. */
  readonly limits?: { readonly maxRequestBytes: number; readonly maxWireRequestBytes: number };
}
export interface ModelHttpConfiguration {
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
  /** Opt-in retries for generation-only endpoints; timeoutMs still bounds the whole call. */
  readonly retry?: ModelRetryOptions;
  readonly fetch?: typeof fetch;
}

export interface ChatCompletionsConfiguration extends ModelHttpConfiguration {
  readonly thinking?: 'enabled' | 'disabled';
}
export interface AnthropicMessagesConfiguration extends ModelHttpConfiguration {
  /** Non-secret deployment and account scope allocated by the host for continuation. */
  readonly bindingId: string;
  readonly thinkingBudgetTokens?: number;
  readonly anthropicVersion: string;
  /** Default output token budget, overridden by request.maxTokens. */
  readonly maxTokens: number;
}

export interface OpenAIResponsesConfiguration extends ModelHttpConfiguration {
  /** Non-secret deployment and account scope allocated by the host for continuation. */
  readonly bindingId: string;
  /** Stateless replay by default. Remote ID continuation depends on provider retention. */
  readonly continuation?: 'replay' | 'previous-response-id';
}

export interface GeminiGenerateContentConfiguration extends ModelHttpConfiguration {
  /** Non-secret deployment and account scope allocated by the host for replay. */
  readonly bindingId: string;
}
