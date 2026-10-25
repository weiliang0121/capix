import { ResourceOffer } from '@capix/resources';
import type { SelectionUsage } from './usage.js';
import type { Message } from '@capix/protocol';

export const SelectionUsageResource = Object.freeze({
  record: new ResourceOffer({
    name: 'selection-usage.record',
    expose: (usage: SelectionUsage, activity) =>
      Object.freeze({
        add(messages: readonly Readonly<Message>[]): void {
          activity.runSync('add', { input: () => ({ count: new Set(messages).size }) }, () => usage.add(messages));
        },
      }),
    timing: 'access',
    describe: () => ({ operation: 'count-selected-messages' }),
  }),
});
