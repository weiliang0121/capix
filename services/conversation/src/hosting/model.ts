import { ChatCompletionsProvider, type ModelProvider } from '@capix/model-provider';
import { resolveConversationOutputBudget, type ConversationOutputBudget } from '../model/budget.js';
import { createDemoModel } from './demo.js';
import { createYieldingFetch } from './transport.js';
import type { ConversationAnswerMode } from './options.js';

/** Only the executable host reads credentials. Neither resources nor persisted content gets them. */
export function createHostModel(mode: 'demo' | 'live'): ModelProvider {
  if (mode === 'demo') return createDemoModel();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey?.trim()) throw new Error('Live mode requires DEEPSEEK_API_KEY');
  return new ChatCompletionsProvider({ endpoint: 'https://api.deepseek.com/chat/completions', apiKey, model: hostModelName(mode), thinking: 'disabled', timeoutMs: 45_000, fetch: createYieldingFetch() });
}

export function hostModelName(mode: 'demo' | 'live'): string {
  return mode === 'demo' ? 'offline-demo' : process.env.DEEPSEEK_MODEL || 'deepseek-flash';
}

/** Public execution configuration only. Credentials never become recovery material. */
export function hostRecoveryConfiguration(mode: 'demo' | 'live', modelName: string, outputBudget: Partial<ConversationOutputBudget> = {}, answerMode: ConversationAnswerMode = 'material'): string {
  return JSON.stringify({ provider: mode === 'live' ? 'https://api.deepseek.com/chat/completions' : 'offline-demo', model: modelName, thinking: 'disabled', policy: answerMode === 'tools' ? 'tool-conversation-v1' : 'material-conversation-v2', outputBudget: resolveConversationOutputBudget(outputBudget) });
}
