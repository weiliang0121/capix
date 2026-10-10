import type { InvocationIdentity } from './identity.js';

/** Established call-local progress. Completion does not imply parent acceptance or delivery. */
export type InvocationProgress = Readonly<{ kind: 'started'; identity: InvocationIdentity } | { kind: 'finished'; identity: InvocationIdentity; status: 'succeeded' | 'failed' }>;
