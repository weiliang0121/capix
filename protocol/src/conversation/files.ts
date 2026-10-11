/** Service-workspace task. At least one operation is required; paths are workspace-relative. */
export type FileTask = { readonly sourcePath: string; readonly output?: { readonly path: string } } | { readonly sourcePath?: never; readonly output: { readonly path: string } };

/** Confirmed publication of a new file; digest identifies the bytes actually written. */
export interface FileReceipt {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
}

/** File publication is independent of answer availability and the overall run result. */
export type FileOutput = { readonly status: 'pending'; readonly path: string } | { readonly status: 'created'; readonly receipt: FileReceipt } | { readonly status: 'not-created'; readonly path: string; readonly reason: 'not-started' | 'cancelled' | 'failed' } | { readonly status: 'unconfirmed'; readonly path: string };
