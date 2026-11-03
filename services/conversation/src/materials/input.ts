import type { ResourcesOf } from '@capix/resources';
import { Node } from '@capix/structure';
import type { ViewSnapshot } from '@capix/view';
import type { AcceptedConversationMessage } from '../scene.js';
import { requireText } from '../text.js';
import { ConversationViewResource, type ConversationMaterialSources } from './view.js';

/** A fixed service input. Query provenance and selected material remain separate. */
export interface ConversationMaterialInput {
  readonly query: {
    readonly transcriptId: string;
    readonly index: number;
    readonly content: string;
  };
  readonly materials: ViewSnapshot<ConversationMaterialSources>;
}

export function createMaterialPreparation() {
  const deps = { view: ConversationViewResource.read.request() };
  return new Node<AcceptedConversationMessage, ConversationMaterialInput, ResourcesOf<typeof deps>>({
    name: 'prepare-conversation-materials',
    deps,
    async run(work) {
      const accepted = work.input;
      if (!accepted || !Number.isSafeInteger(accepted.index) || accepted.index < 0 || accepted.message?.role !== 'user') throw new TypeError('Materials require a formally accepted user message');
      const query = Object.freeze({ transcriptId: requireText(accepted.transcriptId, 'Input transcript identity'), index: accepted.index, content: requireText(accepted.message.content, 'Conversation query') });
      const captured = await work.resources.view.capture();
      if (captured.basis.sources.messages.id !== query.transcriptId) throw new Error('Conversation materials belong to another transcript');
      // Keep original keys and source stamps. The current request is not previous history,
      // even if the host included it (or a later message) in this View.
      const entries = Object.freeze(captured.entries.filter((entry) => entry.source !== 'messages' || entry.key < query.index));
      return Object.freeze({ query, materials: Object.freeze({ basis: captured.basis, entries }) });
    },
  });
}
