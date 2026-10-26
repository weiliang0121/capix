import { ResourceOffer } from '@capix/resources';
import type { ActiveView, ActiveViewSelection, ActiveViewSnapshot } from './active.js';

export interface ActiveViewReader {
  capture(): ActiveViewSnapshot;
}

export interface ActiveViewManager extends ActiveViewReader {
  apply(selection: ActiveViewSelection): ActiveViewSnapshot;
}

function describeSnapshot(snapshot: ActiveViewSnapshot) {
  return { ...snapshot.basis, messageCount: snapshot.messages.length, memoryCount: snapshot.memories.length };
}

/** Material is read by the explicit capture operation, not by structure or resource construction. */
export const ActiveViewResource = Object.freeze({
  read: new ResourceOffer({
    name: 'view.read',
    expose: (content: ActiveView, activity): ActiveViewReader =>
      Object.freeze({
        capture: () => activity.runSync('capture', { output: describeSnapshot }, () => content.capture()),
      }),
    timing: 'access',
    describe: () => ({ capability: 'view.read' }),
  }),
  manage: new ResourceOffer({
    name: 'view.manage',
    expose: (content: ActiveView, activity): ActiveViewManager =>
      Object.freeze({
        capture: () => activity.runSync('capture', { output: describeSnapshot }, () => content.capture()),
        apply: (selection: ActiveViewSelection) => activity.runSync('apply', { input: () => selection, output: describeSnapshot }, () => content.apply(selection)),
      }),
    timing: 'access',
    describe: () => ({ capability: 'view.manage' }),
  }),
});
