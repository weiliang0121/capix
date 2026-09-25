import { createStore } from 'zustand/vanilla';
import { isError, isPlainObject, isString } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';
import type { ClientRuntime } from '@capix-observer/client-runtime';
import type { Message } from '@capix-observer/protocol';
import { defaultColumnWidth, maximumColumnWidth, minimumColumnWidth } from '../features/explorer/layout.js';

export interface Inspection {
  executionId: string;
  callId?: string;
}

export interface AppState {
  selectedId: string;
  inspection?: Inspection;
  memoryOpen: boolean;
  settingsOpen: boolean;
  draft: string;
  history: string;
  budget: string;
  notice: string;
  search: string;
  matchCursor: number;
  columnWidth: number;
}

interface AppActions {
  select: (id: string) => void;
  inspect: (executionId: string, callId?: string) => void;
  closeInspection: () => void;
  setMemoryOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setDraft: (text: string) => void;
  setHistory: (text: string) => void;
  setBudget: (text: string) => void;
  setNotice: (text: string) => void;
  setSearch: (text: string) => void;
  setMatchCursor: (index: number) => void;
  setColumnWidth: (width: number) => void;
  fillExample: () => void;
  submit: () => Promise<void>;
}

export function errorMessage(error: unknown): string {
  return isError(error) ? error.message : String(error);
}

function acceptHistory(text: string): Message[] {
  const value: unknown = JSON.parse(text);
  if (!isArray(value) || value.length > 500) throw new Error('追加历史需要是最多 500 条消息的数组。');
  return value.map((message) => {
    if (!isPlainObject(message) || (message.role !== 'user' && message.role !== 'assistant') || !isString(message.content) || !message.content.trim()) throw new Error('每条消息需要 user / assistant 角色与非空正文。');
    return { role: message.role, content: message.content };
  });
}

/** Application interaction state. Server observations remain owned by ClientRuntime. */
export function createAppStore(runtime: ClientRuntime) {
  return createStore<AppState & AppActions>()((set, get) => ({
    selectedId: '',
    memoryOpen: false,
    settingsOpen: false,
    draft: '',
    history: '[]',
    budget: '32768',
    notice: '',
    search: '',
    matchCursor: -1,
    columnWidth: defaultColumnWidth,
    select: (selectedId) => set({ selectedId }),
    inspect: (executionId, callId) => set({ selectedId: executionId, inspection: { executionId, callId }, memoryOpen: false }),
    closeInspection: () => set({ inspection: undefined }),
    setMemoryOpen: (memoryOpen) => set({ memoryOpen }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setDraft: (draft) => set({ draft }),
    setHistory: (history) => set({ history }),
    setBudget: (budget) => set({ budget }),
    setNotice: (notice) => set({ notice }),
    setSearch: (search) => set({ search, matchCursor: -1 }),
    setMatchCursor: (matchCursor) => set({ matchCursor }),
    setColumnWidth: (width) => set({ columnWidth: Math.min(maximumColumnWidth, Math.max(minimumColumnWidth, width)) }),
    fillExample: () =>
      set({
        history: JSON.stringify(
          [
            { role: 'user', content: '天气怎么样？' },
            { role: 'assistant', content: '你想查询哪个城市？' },
          ],
          null,
          2,
        ),
        draft: '上海',
      }),
    submit: async () => {
      const observed = runtime.getSnapshot();
      if (observed.busy || !observed.config?.configured) return;
      const { draft, history, budget } = get();
      if (!draft.trim()) {
        set({ notice: '请先填写消息。' });
        return;
      }
      try {
        const contextBudget = Number(budget);
        if (!Number.isSafeInteger(contextBudget) || contextBudget < 256 || contextBudget > 1000000) throw new Error('容量预算需要是 256–1000000 的整数。');
        const messages = [...acceptHistory(history), { role: 'user' as const, content: draft }];
        set({ notice: '' });
        await runtime.submit({ messages, contextBudget }, () => {
          // Clear only the submitted edits if a new draft was entered before acceptance.
          set((current) => ({ draft: current.draft === draft ? '' : current.draft, history: current.history === history ? '[]' : current.history }));
        });
      } catch (error) {
        set({ notice: errorMessage(error) });
      }
    },
  }));
}

export type AppStore = ReturnType<typeof createAppStore>;

/** Applies existing presentation policies; cleanup removes the application's subscription. */
export function connectAppStore(store: AppStore, runtime: ClientRuntime): () => void {
  let active = true;
  let previous: ReturnType<ClientRuntime['getSnapshot']> | undefined;
  const receive = () => {
    const observed = runtime.getSnapshot();
    const change: Partial<AppState> = {};
    if (observed.config && observed.config !== previous?.config) change.budget = String(observed.config.contextBudget);
    if (!previous || observed.overview !== previous.overview || observed.runningId !== previous.runningId || observed.busy !== previous.busy) {
      const selectedId = observed.busy && observed.runningId ? observed.runningId : store.getState().selectedId || observed.overview.executions.at(-1)?.id || '';
      if (selectedId !== store.getState().selectedId) change.selectedId = selectedId;
    }
    previous = observed;
    if (Object.keys(change).length) store.setState(change);
  };
  const unsubscribe = runtime.subscribe(receive);
  receive();
  void runtime.initialize().catch((error) => {
    if (active) store.getState().setNotice(errorMessage(error));
  });
  return () => {
    active = false;
    unsubscribe();
  };
}
