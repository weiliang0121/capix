import type { Message } from '@capix/protocol';
import type { ResourcesOf } from '@capix/resources';
import { Scene, Node, type Group } from '@capix/structure';
import { TranscriptResource } from '@capix/transcript';
import { HistoryResource } from './history.js';
import { createAnswerNode } from './answer.js';
import { requireString, requireText } from './text.js';

// The scene constrains child I/O and delta; each child retains its own resource declaration.
export type ConversationAnswer<Input = readonly Readonly<Message>[]> = Node<Input, string, any, string> | Group<Input, string, any, string>;

/** The entity's formal append result; independent of which materials a View selects. */
export interface AcceptedConversationMessage {
  readonly transcriptId: string;
  readonly index: number;
  readonly message: Readonly<Message>;
}

export type ConversationPreparation<Output> = Node<AcceptedConversationMessage, Output, any, any> | Group<AcceptedConversationMessage, Output, any, any>;
export type ConversationMaintenance = Node<AcceptedConversationMessage, void, any, any> | Group<AcceptedConversationMessage, void, any, any>;

function createHistoryPreparation() {
  const deps = { history: HistoryResource.request() };
  return new Node<AcceptedConversationMessage, readonly Readonly<Message>[], ResourcesOf<typeof deps>>({
    name: 'prepare-conversation-history',
    deps,
    run: (work) => work.resources.history.read(work.input.index + 1),
  });
}

/** The supplied answer is an owned child structure, not a shared processor instance. */
export function createConversationScene(answer?: ConversationAnswer, prepare?: undefined, maintain?: ConversationMaintenance): ReturnType<typeof conversationScene<readonly Readonly<Message>[]>>;
export function createConversationScene<Input>(answer: ConversationAnswer<Input>, prepare: ConversationPreparation<NoInfer<Input>>, maintain?: ConversationMaintenance): ReturnType<typeof conversationScene<Input>>;
export function createConversationScene(answer: ConversationAnswer<any> = createAnswerNode(), prepare: ConversationPreparation<any> = createHistoryPreparation(), maintain?: ConversationMaintenance) {
  return conversationScene(answer, prepare, maintain);
}

function conversationScene<Input>(answer: ConversationAnswer<Input>, prepare: ConversationPreparation<Input>, maintain?: ConversationMaintenance) {
  const deps = { messages: TranscriptResource.append.request() };
  const scene = new Scene<string, string, ResourcesOf<typeof deps>, string>({
    name: 'conversation',
    deps,
    output: { result: (value) => requireText(value, 'Conversation answer'), delta: (value) => requireString(value, 'Conversation delta') },
  }).add({ prepare, answer });
  if (maintain) scene.add({ maintain });
  scene.run = async (work) => {
    const text = requireText(work.input, 'Conversation input');
    const [accepted] = work.resources.messages.append([{ role: 'user', content: text }]);
    if (!accepted) throw new Error('Input append did not return its accepted message');
    if (maintain) await work.children.invoke(maintain, accepted);
    const input = await work.children.prepare.invoke(accepted);
    const response = await work.children.answer.invoke(input, {
      delta: (value) => work.output.emit(value),
      result: {
        succeeded: (content) => {
          requireText(content, 'Conversation answer');
          const [message] = work.resources.messages.append([{ role: 'assistant', content }]);
          if (!message) throw new Error('Answer append did not return its accepted message');
          return message;
        },
      },
    });
    // The answer is already formally stored and accepted. Maintenance is a separate child call.
    if (maintain) await work.children.invoke(maintain, response);
    return response.message.content;
  };
  return scene;
}
