import { ResourceOffer } from '../resource/offer.js';
import type { SelectionUsage } from './usage.js';
import type { Message } from '@capix-observer/protocol';

export const SelectionUsageResource = Object.freeze({
  record: new ResourceOffer(
    'selection-usage.record',
    (usage: SelectionUsage, activity) =>
      Object.freeze({
        add(messages: readonly Readonly<Message>[]): void {
          activity.runSync('add', { input: () => ({ count: new Set(messages).size }) }, () => usage.add(messages));
        },
      }),
    'access',
    { describe: () => ({ operation: 'count-selected-messages' }) },
  ),
});
