import type { Message, ObserverOverview } from '@weiliang0121/capix-protocol';
import type { ConversationMessage } from '../state/conversation.js';

/** A view of observed messages, never a write to the server transcript. */
export function projectConversation(messages: readonly Readonly<Message>[], overview: ObserverOverview, transcriptId?: string): ConversationMessage[] {
  const owners = new Map<number, { executionId: string; round: number }>();
  if (!transcriptId || transcriptId === overview.transcriptId) {
    overview.executions.forEach((execution, index) => {
      const owner = { executionId: execution.id, round: index + 1 };
      if (!owners.has(execution.inputIndex)) owners.set(execution.inputIndex, owner);
      if (execution.response?.index !== undefined && !owners.has(execution.response.index)) owners.set(execution.response.index, owner);
    });
  }
  const rows: ConversationMessage[] = messages.map((message, index) => {
    return { key: JSON.stringify([transcriptId ?? null, index]), message, index, ...owners.get(index) };
  });
  return rows;
}
