import type { FileReceipt, FileTask } from '@weiliang0121/capix-protocol';

/** The text is the actual bounded UTF-8 read. Its descriptor identifies those bytes only. */
export interface TextDocument extends FileReceipt {
  readonly text: string;
}

/** Current path evidence only; checking a task never reserves a file or grants IO access. */
export type FileTaskInspection = { readonly kind: 'ready'; readonly task: FileTask } | { readonly kind: 'revise'; readonly reason: string; readonly feedback: string } | { readonly kind: 'needs-input'; readonly reason: string; readonly question: string };

/** Producer facts, independent of invocation results and record consumers. */
export type FileProgress = { readonly kind: 'requested'; readonly path: string } | { readonly kind: 'started'; readonly path: string } | { readonly kind: 'created'; readonly receipt: FileReceipt } | { readonly kind: 'not-created'; readonly path: string; readonly reason: 'cancelled' | 'failed' } | { readonly kind: 'unconfirmed'; readonly path: string };
