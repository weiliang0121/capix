import type { TranscriptRangeLocator } from '@capix/protocol';

/** Facts selected by conversation binding, before service projection or any delivery encoding. */
export type ConversationProgress = { readonly kind: 'input' | 'answer'; readonly range: TranscriptRangeLocator } | { readonly kind: 'execution'; readonly contextId: string };
