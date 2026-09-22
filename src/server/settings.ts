import type { ModelSettings } from '../shared/types.js';
import { isObject } from './value/object.js';
import { RuntimeError } from './errors/error.js';

export function validateSettings(value: unknown): ModelSettings {
  if (!isObject(value) || typeof value.model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(value.model) || !Number.isSafeInteger(value.contextBudget) || Number(value.contextBudget) < 256 || Number(value.contextBudget) > 1_000_000 || !Number.isSafeInteger(value.maxOutputTokens) || Number(value.maxOutputTokens) < 64 || Number(value.maxOutputTokens) > 8192 || !Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1000 || Number(value.timeoutMs) > 180000) {
    throw new RuntimeError('INVALID_SETTINGS', '模型配置无效；容量 256–1000000，输出 64–8192，超时 1000–180000 ms。');
  }
  return {
    model: value.model,
    contextBudget: Number(value.contextBudget),
    maxOutputTokens: Number(value.maxOutputTokens),
    timeoutMs: Number(value.timeoutMs),
  };
}
