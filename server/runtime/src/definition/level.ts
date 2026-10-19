import type { InvocationLevel } from '@capix/protocol';

/** Current REOA positions; both author types and binding validate this same rule. */
export const childLevels = {
  runtime: ['execution'],
  execution: ['operation'],
  operation: ['operation', 'attempt'],
  attempt: [],
} as const satisfies Readonly<Record<InvocationLevel, readonly InvocationLevel[]>>;

export type ChildLevel<Level extends InvocationLevel> = (typeof childLevels)[Level][number];
