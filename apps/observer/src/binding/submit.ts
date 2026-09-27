import type { ClientRuntime } from '@capix-observer/client-runtime';
import type { Message } from '@capix-observer/protocol';
import { isPlainObject, isString } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';
import type { AppStore } from '../state/store.js';
import { errorMessage } from '../lib/errors.js';

function acceptHistory(text: string): Message[] {
  const value: unknown = JSON.parse(text);
  if (!isArray(value) || value.length > 500) throw new Error('追加历史需要是最多 500 条消息的数组。');
  return value.map((message) => {
    if (!isPlainObject(message) || (message.role !== 'user' && message.role !== 'assistant') || !isString(message.content) || !message.content.trim()) throw new Error('每条消息需要 user / assistant 角色与非空正文。');
    return { role: message.role, content: message.content };
  });
}

export async function submitDraft(store: AppStore, runtime: ClientRuntime): Promise<void> {
  const observed = runtime.getSnapshot();
  if (observed.busy || !observed.config?.configured) return;
  const { draft, history, budget } = store.getState();
  if (!draft.trim()) {
    store.setState({ notice: '请先填写消息。' });
    return;
  }
  try {
    const contextBudget = Number(budget);
    if (!Number.isSafeInteger(contextBudget) || contextBudget < 256 || contextBudget > 1000000) throw new Error('容量预算需要是 256–1000000 的整数。');
    const messages = [...acceptHistory(history), { role: 'user' as const, content: draft }];
    store.setState({ notice: '' });
    await runtime.submit({ messages, contextBudget }, () => {
      // Clear only the submitted edits if a new draft was entered before acceptance.
      store.setState((current) => ({ draft: current.draft === draft ? '' : current.draft, history: current.history === history ? '[]' : current.history }));
    });
  } catch (error) {
    store.setState({ notice: errorMessage(error) });
  }
}
