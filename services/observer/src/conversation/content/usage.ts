import { ResourceOffer } from '@capix/server-runtime';
import type { SelectionUsage, Transcript } from '@capix/server-runtime/content';
import type { ActiveContentSnapshot } from './active.js';

/** Resolve immutable material positions for counters, without turning current content into request input. */
export const ConversationMaterialUsageResource = new ResourceOffer(
  'conversation.material-usage',
  ({ transcript, selectionUsage }: { readonly transcript: Transcript; readonly selectionUsage: SelectionUsage }, activity) =>
    Object.freeze({
      add(messages: ActiveContentSnapshot['messages']): void {
        activity.runSync('add', { input: () => ({ indexes: messages.map((item) => item.index) }) }, () => {
          const originals = messages.map(({ index, message }) => {
            const original = transcript.get(index);
            if (!original || original.role !== message.role || original.content !== message.content) throw new Error('Material usage does not match its formal message');
            return original;
          });
          selectionUsage.add(originals);
        });
      },
    }),
  'access',
  { describe: () => ({ operation: 'count-material-messages' }) },
);
