import { ChatCompletionsProvider, type ModelProvider } from '@capix/model-provider';
import { createDemoModel } from './demo.js';

/** Only the executable host reads credentials. Neither resources nor persisted content gets them. */
export function createHostModel(mode: 'demo' | 'live'): ModelProvider {
  if (mode === 'demo') return createDemoModel();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey?.trim()) throw new Error('Live mode requires DEEPSEEK_API_KEY');
  return new ChatCompletionsProvider({ endpoint: 'https://api.deepseek.com/chat/completions', apiKey, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', thinking: 'disabled', timeoutMs: 45_000 });
}
