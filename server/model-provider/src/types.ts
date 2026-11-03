/** Provider messages are transport values, not formal Transcript messages. */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly maxTokens?: number;
  readonly responseFormat?: 'text' | 'json_object';
  readonly temperature?: number;
  /** Request incremental transport; final reply acceptance is unchanged. Defaults to false. */
  readonly stream?: boolean;
}

export interface ModelReply {
  readonly id: string;
  readonly model: string;
  readonly text: string;
  /** Transport completion is not business acceptance; length/empty output stay visible. */
  readonly finishReason: string;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number } | null;
}

export interface ModelControls {
  readonly signal?: AbortSignal;
  /** Synchronous preview consumer. Its failure stops consumption and is returned unchanged. */
  readonly emit?: (delta: string) => void;
}

/** Small injectable capability. Prompts, schemas and result acceptance belong to its consumer. */
export interface ModelProvider {
  complete(request: ModelRequest, controls?: ModelControls): Promise<ModelReply>;
}

export interface ChatCompletionsConfiguration {
  /** Complete endpoint, e.g. https://api.deepseek.com/chat/completions. */
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Optional DeepSeek extension. Omitted for endpoints that do not support it. */
  readonly thinking?: 'enabled' | 'disabled';
  /** Test/host transport; must honor Fetch abort and redirect semantics. */
  readonly fetch?: typeof fetch;
}
