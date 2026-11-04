/** Per-request output ceilings for this service policy, not context-window estimates. */
export interface ConversationOutputBudget {
  readonly answer: number;
  readonly memory: number;
}

// The 54-submission study exhausted 1,200/3,000 tokens. These leave headroom;
// they are ceilings, not a promise that every possible answer will fit.
export const defaultConversationOutputBudget: ConversationOutputBudget = Object.freeze({ answer: 4096, memory: 8192 });

export function requireOutputTokens(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Output token budget must be a positive safe integer');
  return value;
}

export function resolveConversationOutputBudget(value: Partial<ConversationOutputBudget> = {}): ConversationOutputBudget {
  return Object.freeze({ answer: requireOutputTokens(value.answer === undefined ? defaultConversationOutputBudget.answer : value.answer), memory: requireOutputTokens(value.memory === undefined ? defaultConversationOutputBudget.memory : value.memory) });
}
