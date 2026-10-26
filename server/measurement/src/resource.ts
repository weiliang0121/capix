import { ResourceOffer } from '@capix/resources';
import type { MessageUsage } from './usage.js';
import type { Message } from '@capix/protocol';

export const MessageUsageResource = Object.freeze({
  record: new ResourceOffer({
    name: 'message-usage.record',
    expose: (usage: MessageUsage, activity) =>
      Object.freeze({
        add(messages: readonly Readonly<Message>[]): void {
          activity.runSync('add', { input: () => ({ count: new Set(messages).size }) }, () => usage.add(messages));
        },
      }),
    timing: 'access',
    describe: () => ({ operation: 'count-selected-messages' }),
  }),
});
