import { createConversationRunner, createConversationScene, CompletionResource } from '@capix/conversation-service';
import type { ModelProvider, ModelRequest, ModelReply, ModelMessage } from '@weiliang0121/capix-model-provider';
import type { Message } from '@weiliang0121/capix-protocol';
import { Resource, type ResourcesOf } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Transcript } from '@weiliang0121/capix-transcript';

const model: ModelProvider = {
  async complete(request, controls) {
    const history: readonly ModelMessage[] = request.messages;
    const signal: AbortSignal | undefined = controls?.signal;
    const emit: ((delta: string) => void) | undefined = controls?.emit;
    emit?.('preview');
    // @ts-expect-error Model producers can emit only text chunks.
    emit?.(42);
    void [history, signal];
    return { id: 'reply', model: 'test', formatVersion: 1, output: [{ kind: 'text', text: 'answer' }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null };
  },
};
const runner = createConversationRunner(new Transcript(), model);
const answer: Promise<string> = runner.run('question');
runner.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') {
      const text: string = event.delta;
      // @ts-expect-error The service declares string deltas, not arbitrary values.
      const wrong: number = event.delta;
      void [text, wrong];
    }
  },
});
// @ts-expect-error The service accepts text, not an arbitrary request object.
runner.run({ input: 'question' });
// @ts-expect-error The service result remains text rather than unknown or any.
const incorrectAnswer: Promise<number> = runner.run('question');

const scene = createConversationScene();
scene.run = async (work) => {
  const input: string = work.input;
  const [message] = work.resources.messages.append([{ role: 'user', content: input }]);
  if (!message) throw new Error('Input was not appended');
  const history: readonly Readonly<Message>[] = await work.children.prepare.invoke(message);
  const content: string = await work.children.answer.invoke(history, {
    delta(text) {
      const chunk: string = text;
      work.output.emit(chunk);
    },
  });
  // @ts-expect-error Scene output retains its declared text delta type.
  work.output.emit(42);
  // @ts-expect-error The answer node does not emit numerical deltas.
  await work.children.answer.invoke(history, { delta: (value: number) => void value });
  // @ts-expect-error Only the registered answer child has a named port.
  await work.children.unregistered.invoke(history);
  // @ts-expect-error The answer child consumes messages rather than raw text.
  await work.children.answer.invoke(input);
  // @ts-expect-error Preparation needs the formal append result, not a raw string.
  await work.children.prepare.invoke(input);
  // @ts-expect-error History is scoped to the preparation child, not implicitly given to the Scene.
  work.resources.history;
  // @ts-expect-error The Scene does not inherit its child's model dependency.
  work.resources.model.complete(history);
  return content;
};

const deps = { model: CompletionResource.request() };
const generated = new Node<ModelRequest, ModelReply, ResourcesOf<typeof deps>>({
  deps,
  run(work) {
    const result: Promise<ModelReply> = work.resources.model.complete(work.input);
    work.resources.model.complete(work.input, {
      delta(text) {
        const chunk: string = text;
        void chunk;
      },
    });
    // @ts-expect-error The resource operation retains the model's text delta contract.
    work.resources.model.complete(work.input, { delta: (value: number) => void value });
    // @ts-expect-error A model method requires messages rather than text.
    work.resources.model.complete('question');
    // @ts-expect-error An undeclared resource cannot appear through ResourcesOf.
    work.resources.messages.append([]);
    return result;
  },
});
const resources = new Resources().register(new Resource(model), CompletionResource);
const customRunner = new Runner(new Scene(generated), resources).build();
const customResult: Promise<ModelReply> = customRunner.run({ messages: [{ role: 'user', content: 'question' }] });
// @ts-expect-error The delegating Scene retains the Node's message input.
customRunner.run('question');

void [answer, incorrectAnswer, scene, customResult];
