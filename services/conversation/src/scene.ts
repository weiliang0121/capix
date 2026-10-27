import type { Message } from '@capix/protocol';
import type { ResourcesOf } from '@capix/resources';
import { Node, Scene } from '@capix/structure';
import { TranscriptResource } from '@capix/transcript';
import { HistoryResource } from './history.js';
import { ModelResource } from './model.js';

/** Every call to this factory owns new structures; only registered entities may be shared. */
export function createConversationScene() {
  const answerDeps = { model: ModelResource.request() };
  const answer = new Node<readonly Readonly<Message>[], string, ResourcesOf<typeof answerDeps>>({
    name: 'answer',
    deps: answerDeps,
    output: { result: (value) => requireText(value, 'Model answer') },
    run: (work) => work.resources.model.generate(work.input),
  });
  const deps = { messages: TranscriptResource.append.request(), history: HistoryResource.request() };
  const scene = new Scene<string, string, ResourcesOf<typeof deps>>({ name: 'conversation', deps }).add({ answer });
  scene.run = async (work) => {
    const text = requireText(work.input, 'Conversation input');
    const [accepted] = work.resources.messages.append([{ role: 'user', content: text }]);
    if (!accepted) throw new Error('Input append did not return its accepted message');
    const history = await work.resources.history.read(accepted.index + 1);
    return work.children.answer.invoke(history, {
      result: {
        succeeded: (content) => {
          work.resources.messages.append([{ role: 'assistant', content }]);
          return content;
        },
      },
    });
  };
  return scene;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/\S/.test(value)) throw new TypeError(`${label} must be nonblank text`);
  return value;
}
