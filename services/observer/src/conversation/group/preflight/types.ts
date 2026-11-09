import type { FileTask } from '@weiliang0121/capix-protocol';

export interface FilePreflightInput {
  readonly task: FileTask;
  readonly instruction: string;
}

/** A preflight result is evidence for choosing work, never a reservation or write receipt. */
export type FilePreflightOutput = { readonly kind: 'ready'; readonly task: FileTask; readonly instruction: string } | { readonly kind: 'revise'; readonly reason: string; readonly feedback: string } | { readonly kind: 'needs-input'; readonly reason: string; readonly question: string };
