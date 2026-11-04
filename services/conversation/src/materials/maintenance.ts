import type { ResourcesOf } from '@capix/resources';
import { Node, checkpointPoint } from '@capix/structure';
import type { AcceptedConversationMessage } from '../scene.js';
import { requireText } from '../text.js';
import { ConversationViewResource } from './view.js';
import { acceptedMessageCodec, voidCodec } from '../recovery/codecs.js';

/** An optional policy: include this formally appended message, without scanning prior history. */
export function createMessageInclusion() {
  const deps = { view: ConversationViewResource.manage.request() };
  function include(resources: ResourcesOf<typeof deps>, accepted: AcceptedConversationMessage) {
    if (!accepted || !Number.isSafeInteger(accepted.index) || accepted.index < 0 || (accepted.message?.role !== 'user' && accepted.message?.role !== 'assistant')) throw new TypeError('Inclusion requires a formally accepted conversation message');
    requireText(accepted.message.content, 'Accepted message content');
    if (accepted.transcriptId !== resources.view.transcriptId) throw new Error('Accepted message belongs to another transcript');
    // This policy ensures this member; it does not claim a historical View receipt.
    resources.view.include([{ source: 'messages', key: accepted.index }]);
  }
  const completed = checkpointPoint<'node', AcceptedConversationMessage, void>()({ name: 'completed', state: voidCodec, references: {}, resume: { run() {} } });
  const prepared = checkpointPoint<'node', AcceptedConversationMessage, void>()({
    name: 'prepared',
    state: voidCodec,
    references: {},
    resume: {
      deps,
      run(work) {
        include(work.resources, work.input);
        work.checkpoint?.({ point: completed, state: undefined, refs: {} });
      },
    },
  });
  return new Node<AcceptedConversationMessage, void, ResourcesOf<typeof deps>>({
    name: 'include-conversation-message',
    deps,
    checkpoint: { key: 'conversation.message.include', version: 1, input: acceptedMessageCodec, output: voidCodec, points: [prepared, completed] },
    run(work) {
      work.checkpoint?.({ point: prepared, state: undefined, refs: {} });
      include(work.resources, work.input);
      work.checkpoint?.({ point: completed, state: undefined, refs: {} });
    },
  });
}
