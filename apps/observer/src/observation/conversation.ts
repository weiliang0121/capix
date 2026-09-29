import type { Message, ObserverOverview } from '@capix-observer/protocol';

export interface ConversationMessage {
  key: string;
  message: Readonly<Message>;
  index?: number;
  executionId?: string;
  round?: number;
}

/** A view of observed messages, never a write to the server transcript. */
export function projectConversation(messages: readonly Readonly<Message>[], overview: ObserverOverview): ConversationMessage[] {
  const rows: ConversationMessage[] = messages.map((message, index) => {
    const round = overview.executions.findIndex((execution) => execution.inputIndex === index || execution.response?.index === index);
    return { key: `message-${index}`, message, index, ...(round >= 0 ? { executionId: overview.executions[round]!.id, round: round + 1 } : {}) };
  });
  return rows;
}
