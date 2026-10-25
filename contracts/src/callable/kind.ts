/** Structural vocabulary; this does not decide invocation dispatch or member legality. */
export const callableKinds = ['scene', 'group', 'node'] as const;
export type CallableKind = (typeof callableKinds)[number];
