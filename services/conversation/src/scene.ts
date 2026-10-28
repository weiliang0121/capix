import type { Message } from '@capix/protocol';
import type { ResourcesOf } from '@capix/resources';
import { Scene, type Node, type Group } from '@capix/structure';
import { TranscriptResource } from '@capix/transcript';
import { HistoryResource } from './history.js';
import { createAnswerNode } from './answer.js';
import { requireString, requireText } from './text.js';

// The scene constrains child I/O and delta; each child retains its own resource declaration.
export type ConversationAnswer = Node<readonly Readonly<Message>[], string, any, string> | Group<readonly Readonly<Message>[], string, any, string>;

/** The supplied answer is an owned child structure, not a shared processor instance. */
export function createConversationScene(answer: ConversationAnswer = createAnswerNode()) {
  const deps = { messages: TranscriptResource.append.request(), history: HistoryResource.request() };
  const scene = new Scene<string, string, ResourcesOf<typeof deps>, string>({
    name: 'conversation',
    deps,
    output: { result: (value) => requireText(value, 'Conversation answer'), delta: (value) => requireString(value, 'Conversation delta') },
  }).add({ answer });
  scene.run = async (work) => {
    const text = requireText(work.input, 'Conversation input');
    const [accepted] = work.resources.messages.append([{ role: 'user', content: text }]);
    if (!accepted) throw new Error('Input append did not return its accepted message');
    const history = await work.resources.history.read(accepted.index + 1);
    return work.children.answer.invoke(history, {
      delta: (value) => work.output.emit(value),
      result: {
        succeeded: (content) => {
          requireText(content, 'Conversation answer');
          work.resources.messages.append([{ role: 'assistant', content }]);
          return content;
        },
      },
    });
  };
  return scene;
}
