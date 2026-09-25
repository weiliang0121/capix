import type { ModelSettings } from '@capix-observer/protocol';
import type { ModelRequest } from './types.js';
import { RuntimeError } from '@capix-observer/runtime';

export function estimateCapacity(request: ModelRequest, settings: ModelSettings) {
  const inputBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  const estimatedInputTokens = inputBytes + 256;
  const required = estimatedInputTokens + request.max_tokens;
  return {
    method: 'UTF-8 bytes of full request + 256 reserve',
    exact: false,
    note: '保守的本地估算，不是 DeepSeek tokenizer；服务端仍可能拒绝。',
    inputBytes,
    estimatedInputTokens,
    reservedOutputTokens: request.max_tokens,
    contextBudget: settings.contextBudget,
    required,
    fits: required <= settings.contextBudget,
  };
}

export function checkCapacity(request: ModelRequest, settings: ModelSettings): void {
  const result = estimateCapacity(request, settings);
  if (!result.fits) throw new RuntimeError('CAPACITY_EXCEEDED', `本地容量检查拒绝：估算需求 ${result.required} > 预算 ${settings.contextBudget}。未调用模型。`, result);
}
