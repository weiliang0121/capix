import type { CallableKind } from '@weiliang0121/capix-contracts';

/** Structural membership only; execution and resource lifecycles do not dispatch on kind. */
export const childKinds = {
  scene: ['group', 'node'],
  group: ['group', 'node'],
  node: [],
} as const satisfies Readonly<Record<CallableKind, readonly CallableKind[]>>;

export type ChildKind<Kind extends CallableKind> = (typeof childKinds)[Kind][number];
