import type { FileReceipt } from '@capix/protocol';

/** The text is the actual bounded UTF-8 read. Its descriptor identifies those bytes only. */
export interface TextDocument extends FileReceipt {
  readonly text: string;
}

/** Producer facts, independent of invocation results and record consumers. */
export type FileProgress = { readonly kind: 'requested'; readonly path: string } | { readonly kind: 'started'; readonly path: string } | { readonly kind: 'created'; readonly receipt: FileReceipt } | { readonly kind: 'not-created'; readonly path: string; readonly reason: 'cancelled' | 'failed' } | { readonly kind: 'unconfirmed'; readonly path: string };
