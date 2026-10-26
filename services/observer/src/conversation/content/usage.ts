import { ResourceOffer } from '@capix/resources';
import type { MessageUsage } from '@capix/measurement';
import type { Transcript } from '@capix/transcript';
import type { ActiveViewSnapshot } from '@capix/view';

/** Resolve immutable material positions for counters, without turning current content into request input. */
export const ConversationMaterialUsageResource = new ResourceOffer({
  name: 'conversation.material-usage',
  expose: ({ transcript, messageUsage }: { readonly transcript: Transcript; readonly messageUsage: MessageUsage }, activity) =>
    Object.freeze({
      add(messages: ActiveViewSnapshot['messages']): void {
        activity.runSync('add', { input: () => ({ indexes: messages.map((item) => item.index) }) }, () => {
          const originals = messages.map(({ index, message }) => {
            const original = transcript.get(index);
            if (!original || original.role !== message.role || original.content !== message.content) throw new Error('Material usage does not match its formal message');
            return original;
          });
          messageUsage.add(originals);
        });
      },
    }),
  timing: 'access',
  describe: () => ({ operation: 'count-material-messages' }),
});
