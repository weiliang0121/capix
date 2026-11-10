import type { FileTask } from './files.js';

/** The service's accepted task choice, independent of completion or output publication. */
export type ConversationTask = { readonly kind: 'reply' } | { readonly kind: 'file'; readonly task: FileTask } | { readonly kind: 'clarify' } | { readonly kind: 'unsupported' };
