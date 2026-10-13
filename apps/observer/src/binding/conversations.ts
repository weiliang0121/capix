import type { AppState } from '../state/store.js';

/** Keep editable input local to its conversation; fetched content comes from runtime. */
export function projectConversationChange(current: AppState, nextId: string | undefined): Partial<AppState> {
  const previousId = current.data.activeConversation?.id;
  if (previousId === nextId) return {};
  const conversationDrafts = new Map(current.conversationDrafts);
  if (previousId) conversationDrafts.set(previousId, { draft: current.draft, fileDraft: current.fileDraft, history: current.history });
  const saved = nextId ? conversationDrafts.get(nextId) : undefined;
  // Input typed before the first baseline belongs to the first opened conversation.
  const draft = saved ?? (previousId ? { draft: '', fileDraft: { sourcePath: '', outputPath: '' }, history: '[]' } : { draft: current.draft, fileDraft: current.fileDraft, history: current.history });
  if (!previousId) return { ...draft, conversationDrafts };
  return { ...draft, conversationDrafts, selectedId: '', inspection: undefined, memoryOpen: false, settingsOpen: false, conversationFocus: undefined, search: '', matchCursor: -1, notice: '' };
}
