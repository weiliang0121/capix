import type { Message } from '@capix/protocol';
import type { ResourcesOf } from '@capix/resources';
import { Node } from '@capix/structure';
import { CompletionResource, requireCompletionText } from './completion.js';
import { requireCompletionReply } from './model/completion-contract.js';
import { requireString, requireText } from './text.js';

/** Direct model processing. Its dependency and incremental output are both explicit. */
export function createAnswerNode() {
  const deps = { model: CompletionResource.request() };
  return new Node<readonly Readonly<Message>[], string, ResourcesOf<typeof deps>, string>({
    name: 'answer',
    deps,
    output: { result: (value) => requireText(value, 'Model answer'), delta: (value) => requireString(value, 'Model delta') },
    async run(work) {
      const reply = await work.resources.model.complete({ messages: work.input, responseFormat: 'text', stream: true }, { delta: (value) => work.output.emit(value) });
      return requireCompletionText(requireCompletionReply(reply));
    },
  });
}
