import type { Message, ObserverOverview } from '@capix-observer/protocol';

interface ConversationMessage {
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
  for (const [round, execution] of overview.executions.entries()) {
    const response = execution.response;
    if (!response) continue;
    if (response.index !== undefined && messages[response.index]?.role === 'assistant') continue;
    const inputPosition = rows.findIndex((row) => row.index === execution.inputIndex);
    rows.splice(inputPosition < 0 ? rows.length : inputPosition + 1, 0, { key: `response-${execution.id}`, message: { role: 'assistant', content: response.content }, index: response.index, executionId: execution.id, round: round + 1 });
  }
  return rows;
}
