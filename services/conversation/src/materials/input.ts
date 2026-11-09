import type { ResourcesOf } from '@weiliang0121/capix-resources';
import { Node, checkpointPoint } from '@weiliang0121/capix-structure';
import type { ViewSnapshot } from '@weiliang0121/capix-view';
import type { AcceptedConversationMessage } from '../scene.js';
import { requireText } from '../text.js';
import { ConversationViewResource, type ConversationMaterialSources } from './view.js';
import { acceptedMessageCodec } from '../recovery/codecs.js';
import { materialInputCodec } from '../recovery/model-codecs.js';

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
  const captured = checkpointPoint<'node', AcceptedConversationMessage, ConversationMaterialInput>()({
    name: 'captured',
    state: materialInputCodec,
    references: {},
    check: (input, facts) => {
      if (facts.input.message.role !== 'user' || input.query.transcriptId !== facts.input.transcriptId || input.query.index !== facts.input.index || input.query.content !== facts.input.message.content) throw new Error('Saved materials differ from the accepted query');
    },
    resume: { run: (_work, input) => input },
  });
  return new Node<AcceptedConversationMessage, ConversationMaterialInput, ResourcesOf<typeof deps>>({
    name: 'prepare-conversation-materials',
    deps,
    checkpoint: { key: 'conversation.material-preparation', version: 1, input: acceptedMessageCodec, output: materialInputCodec, points: [captured] },
    async run(work) {
      const accepted = work.input;
      if (!accepted || !Number.isSafeInteger(accepted.index) || accepted.index < 0 || accepted.message?.role !== 'user') throw new TypeError('Materials require a formally accepted user message');
      const query = Object.freeze({ transcriptId: requireText(accepted.transcriptId, 'Input transcript identity'), index: accepted.index, content: requireText(accepted.message.content, 'Conversation query') });
      const snapshot = await work.resources.view.capture();
      if (snapshot.basis.sources.messages.id !== query.transcriptId) throw new Error('Conversation materials belong to another transcript');
      // Keep original keys and source stamps. The current request is not previous history,
      // even if the host included it (or a later message) in this View.
      const entries = Object.freeze(snapshot.entries.filter((entry) => entry.source !== 'messages' || entry.key < query.index));
      const input = Object.freeze({ query, materials: Object.freeze({ basis: snapshot.basis, entries }) });
      work.checkpoint?.({ point: captured, state: input, refs: {} });
      return input;
    },
  });
}
