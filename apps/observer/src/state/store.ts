import { createStore } from 'zustand/vanilla';
import { emptyAppData } from './data.js';
import type { AppData, SearchMatch } from './data.js';
import { defaultColumnWidth, maximumColumnWidth, minimumColumnWidth } from './preferences.js';
export interface Inspection {
  executionId: string;
  callId?: string;
}

export interface AppState {
  data: AppData;
  matches: readonly SearchMatch[];
  selectedId: string;
  inspection?: Inspection;
  memoryOpen: boolean;
  settingsOpen: boolean;
  draft: string;
  fileDraft: { sourcePath: string; outputPath: string };
  conversationFocus?: string;
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
  setFileDraft: (draft: { sourcePath: string; outputPath: string }) => void;
  setHistory: (text: string) => void;
  setBudget: (text: string) => void;
  setNotice: (text: string) => void;
  setSearch: (text: string) => void;
  setMatchCursor: (index: number) => void;
  setColumnWidth: (width: number) => void;
  fillExample: () => void;
}

/** Application read models and interaction state; only the binding writes observed data. */
export function createAppStore() {
  return createStore<AppState & AppActions>()((set) => ({
    data: emptyAppData(),
    matches: [],
    selectedId: '',
    memoryOpen: false,
    settingsOpen: false,
    draft: '',
    fileDraft: { sourcePath: '', outputPath: '' },
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
    setFileDraft: (fileDraft) => set({ fileDraft }),
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
  }));
}

export type AppStore = ReturnType<typeof createAppStore>;
