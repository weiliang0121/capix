import type { Memories, MemoryBasis, MemoryState } from '@weiliang0121/capix-memory';
import type { Message } from '@weiliang0121/capix-protocol';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import type { AcceptedConversationMessage } from '../scene.js';

/** A fixed extraction input, including inactive memories so updates can retain identity. */
export interface ConversationMemoryContext {
  readonly basis: MemoryBasis;
  readonly acceptedIndex: number;
  readonly messages: readonly { readonly index: number; readonly message: Readonly<Message> }[];
  readonly memories: readonly Readonly<MemoryState>[];
}

/** Service policy: use the complete formal prefix and current collection, without hidden selection. */
export const ConversationMemoryResource = new ResourceOffer({
  name: 'conversation.memory.context',
  methods: {
    capture(memories: Memories, accepted: AcceptedConversationMessage): ConversationMemoryContext {
      const transcript = memories.transcript;
      if (!accepted || accepted.transcriptId !== transcript.id || !Number.isSafeInteger(accepted.index) || accepted.index < 0 || accepted.message?.role !== 'assistant') throw new TypeError('Memory maintenance requires a formal assistant message from this transcript');
      const message = transcript.get(accepted.index);
      if (!message || message.role !== accepted.message.role || message.content !== accepted.message.content) throw new Error('Memory maintenance input does not match its formal message');
      const items = Object.freeze(memories.snapshot().map((memory) => Object.freeze(memory)));
      if (items.some((memory) => memory.sourceIndexes.some((index) => index > accepted.index) || memory.sourceResults?.some((source) => source.answerIndex > accepted.index))) throw new Error('Memory maintenance cannot use memories from beyond the supplied prefix');
      return Object.freeze({
        basis: Object.freeze({ memoriesId: memories.id, transcriptId: transcript.id, sequence: memories.sequence }),
        acceptedIndex: accepted.index,
        messages: Object.freeze(transcript.snapshot(accepted.index + 1).map((message, index) => Object.freeze({ index, message }))),
        memories: items,
      });
    },
  },
  observation: {
    methods: { capture: { input: (accepted) => ({ transcriptId: accepted.transcriptId, index: accepted.index }), output: (context) => ({ ...context.basis, messages: context.messages.length, memories: context.memories.length }) } },
  },
});
