import type { ResourcesOf } from '@capix/resources';
import { Node } from '@capix/structure';
import type { AcceptedConversationMessage } from '../scene.js';
import { requireText } from '../text.js';
import { ConversationViewResource } from './view.js';

/** An optional policy: include this formally appended message, without scanning prior history. */
export function createMessageInclusion() {
  const deps = { view: ConversationViewResource.manage.request() };
  return new Node<AcceptedConversationMessage, void, ResourcesOf<typeof deps>>({
    name: 'include-conversation-message',
    deps,
    run(work) {
      const accepted = work.input;
      if (!accepted || !Number.isSafeInteger(accepted.index) || accepted.index < 0 || (accepted.message?.role !== 'user' && accepted.message?.role !== 'assistant')) throw new TypeError('Inclusion requires a formally accepted conversation message');
      requireText(accepted.message.content, 'Accepted message content');
      if (accepted.transcriptId !== work.resources.view.transcriptId) throw new Error('Accepted message belongs to another transcript');
      work.resources.view.include([{ source: 'messages', key: accepted.index }]);
    },
  });
}
