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

/** Material is read by the explicit capture operation, not by structure or resource construction. */
export const ActiveContentResource = Object.freeze({
  read: new ResourceOffer({
    name: 'active-content.read',
    expose: (content: ActiveContent, activity): ActiveContentReader =>
      Object.freeze({
        capture: () => activity.runSync('capture', { output: describeSnapshot }, () => content.capture()),
      }),
    timing: 'access',
    describe: () => ({ capability: 'active-content.read' }),
  }),
  manage: new ResourceOffer({
    name: 'active-content.manage',
    expose: (content: ActiveContent, activity): ActiveContentManager =>
      Object.freeze({
        capture: () => activity.runSync('capture', { output: describeSnapshot }, () => content.capture()),
        apply: (selection: ActiveContentSelection) => activity.runSync('apply', { input: () => selection, output: describeSnapshot }, () => content.apply(selection)),
      }),
    timing: 'access',
    describe: () => ({ capability: 'active-content.manage' }),
  }),
});
