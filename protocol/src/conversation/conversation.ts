/** A durable content identity, independent of runtime instances and submission lifetimes. */
export interface ConversationDescriptor {
  readonly id: string;
  readonly title: string;
  readonly transcriptId: string;
  readonly createdAt: number;
  /** Updated by accepted content, not by opening a view or receiving observation. */
  readonly updatedAt: number;
}

export interface ConversationListResponse {
  readonly conversations: readonly ConversationDescriptor[];
  /** Stable initial selection; requests always carry their own explicit target. */
  readonly defaultConversationId: string;
}
