import { ResourceOffer } from '@capix/server-runtime';
import type { ActiveContent, ActiveContentSelection, ActiveContentSnapshot } from './active.js';

export interface ActiveContentReader {
  capture(): ActiveContentSnapshot;
}

export interface ActiveContentManager extends ActiveContentReader {
  apply(selection: ActiveContentSelection): ActiveContentSnapshot;
}

function describeSnapshot(snapshot: ActiveContentSnapshot) {
  return { ...snapshot.basis, messageCount: snapshot.messages.length, memoryCount: snapshot.memories.length };
}

/** Endpoints read at the explicit capture action, not when an E or its resource bindings are created. */
export const ActiveContentResource = Object.freeze({
  read: new ResourceOffer(
    'active-content.read',
    (content: ActiveContent, activity): ActiveContentReader =>
      Object.freeze({
        capture: () => activity.runSync('capture', { output: describeSnapshot }, () => content.capture()),
      }),
    'access',
    { describe: () => ({ capability: 'active-content.read' }) },
  ),
  manage: new ResourceOffer(
    'active-content.manage',
    (content: ActiveContent, activity): ActiveContentManager =>
      Object.freeze({
        capture: () => activity.runSync('capture', { output: describeSnapshot }, () => content.capture()),
        apply: (selection: ActiveContentSelection) => activity.runSync('apply', { input: () => selection, output: describeSnapshot }, () => content.apply(selection)),
      }),
    'access',
    { describe: () => ({ capability: 'active-content.manage' }) },
  ),
});
