export type Purpose = 'selection' | 'answer' | 'memory';
export interface Selection {
  historyIndexes: number[];
}
export interface ModelRequest {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  response_format: { type: 'json_object' };
  thinking: { type: 'disabled' };
  max_tokens: number;
  stream: false;
}
export interface ModelOutput {
  id: string;
  model: string;
  content: string;
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}
