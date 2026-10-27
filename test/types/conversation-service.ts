import { createConversationRunner, createConversationScene, ModelResource, type TextModel } from '@capix/conversation-service';
import type { Message } from '@capix/protocol';
import { Resource, type ResourcesOf } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Node, Scene } from '@capix/structure';
import { Transcript } from '@capix/transcript';

const model: TextModel = {
  generate(messages, controls) {
    const history: readonly Readonly<Message>[] = messages;
    const signal: AbortSignal | undefined = controls.signal;
    void [history, signal];
    return 'answer';
  },
};
const runner = createConversationRunner(new Transcript(), model);
const answer: Promise<string> = runner.run('question');
// @ts-expect-error The service accepts text, not an arbitrary request object.
runner.run({ input: 'question' });
// @ts-expect-error The service result remains text rather than unknown or any.
const incorrectAnswer: Promise<number> = runner.run('question');

const scene = createConversationScene();
scene.run = async (work) => {
  const input: string = work.input;
  const [message] = work.resources.messages.append([{ role: 'user', content: input }]);
  if (!message) throw new Error('Input was not appended');
  const history: readonly Readonly<Message>[] = await work.resources.history.read(message.index + 1);
  const content: string = await work.children.answer.invoke(history);
  // @ts-expect-error Only the registered answer child has a named port.
  await work.children.unregistered.invoke(history);
  // @ts-expect-error The answer child consumes messages rather than raw text.
  await work.children.answer.invoke(input);
  // @ts-expect-error The history resource reads through a numerical position.
  await work.resources.history.read(input);
  // @ts-expect-error The Scene does not inherit its child's model dependency.
  work.resources.model.generate(history);
  return content;
};

const deps = { model: ModelResource.request() };
const generated = new Node<readonly Readonly<Message>[], string, ResourcesOf<typeof deps>>({
  deps,
  run(work) {
    const result: Promise<string> = work.resources.model.generate(work.input);
    // @ts-expect-error A model method requires messages rather than text.
    work.resources.model.generate('question');
    // @ts-expect-error An undeclared resource cannot appear through ResourcesOf.
    work.resources.messages.append([]);
    return result;
  },
});
const resources = new Resources().register(new Resource(model), ModelResource);
const customRunner = new Runner(new Scene(generated), resources).build();
const customResult: Promise<string> = customRunner.run([{ role: 'user', content: 'question' }]);
// @ts-expect-error The delegating Scene retains the Node's message input.
customRunner.run('question');

void [answer, incorrectAnswer, scene, customResult];
