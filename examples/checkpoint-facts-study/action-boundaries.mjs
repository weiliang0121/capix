import { Invocation, InvocationContext } from '@weiliang0121/capix-invocation';

// Test assembly only. Action remains the existing call/reception operation;
// this helper installs no draft lifecycle, snapshot recovery or new state owner.
export function createBoundaryCall({ input = null, parent, binding, store, execute, signal = new AbortController().signal, key, observe }) {
  const context = new InvocationContext(input);
  return new Invocation({
    context,
    identity: { contextId: context.id, kind: parent ? 'node' : 'group', ...(parent ? { parentContextId: parent.context.id } : {}) },
    signal,
    ...(parent ? { parent: { invocation: parent, declarationPosition: 0, ...(key ? { key } : {}) } } : {}),
    ...(store ? { checkpoints: { store } } : {}),
    ...(observe ? { observation: observe } : {}),
    work: { execute, ...(binding ? { checkpoint: binding } : {}) },
  });
}
