import type { Message } from '@capix/protocol';

export interface ConversationMessage {
  key: string;
  message: Readonly<Message>;
  index?: number;
  executionId?: string;
  round?: number;
  processes?: readonly ConversationProcess[];
}

export interface ConversationProcess {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
  readonly notice?: string;
  readonly inputPending: boolean;
}
