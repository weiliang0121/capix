import { createConversationScene, createInteractionAnswer, createCompletionReplyNode, CompletionInteractionResource, ModelReplyPending, CompletionInteraction } from '@capix/conversation-service';
import { Interactions, type InteractionCursor, type InteractionReference } from '@capix/interaction';
import type { ModelReply } from '@capix/model-provider';
import type { Message } from '@capix/protocol';
import type { ResourcesOf } from '@capix/resources';
import { Node, Scene } from '@capix/structure';
import { Resources, Runner } from '@capix/server-runtime';

type Messages = readonly Readonly<Message>[];
const messages: Messages = [{ role: 'user', content: 'question' }];
const interactions = new Interactions().register(CompletionInteraction, {
  send(request, { publish }) {
    const history = request.messages;
    publish('preview');
    // @ts-expect-error Model process feedback is text, not a provider envelope.
    publish({ text: 'preview' });
    void history;
    return { id: 'reply', model: 'test', text: 'answer', finishReason: 'stop', usage: null };
  },
});
// @ts-expect-error Feedback must satisfy the complete ModelReply contract.
new Interactions().register(CompletionInteraction, { send: () => ({ content: 'answer' }) });
const channel = interactions.bind(CompletionInteraction);
const reference: InteractionReference = channel.start({ messages });
// @ts-expect-error Sending requires structured messages rather than raw text.
channel.start('question');
// @ts-expect-error A feedback reader requires the complete interaction reference.
channel.read(reference.id);

const pending = new ModelReplyPending(reference);
const retained: InteractionReference = pending.reference;
// @ts-expect-error A pending reply cannot change its exchange identity.
pending.reference = reference;
void retained;

const resources = new Resources().registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
const reader = new Runner(new Scene(createCompletionReplyNode(0)), resources, interactions).build();
const reply: Promise<ModelReply> = reader.run(reference);
// @ts-expect-error This scene only reads a reference; it does not accept another model request.
reader.run(messages);
// @ts-expect-error A reference is a value carrying id and contract, not just an id.
reader.run(reference.id);
void reply;

const deps = { start: CompletionInteractionResource.start.request(), feedback: CompletionInteractionResource.feedback.request() };
const startAndRead = new Node<Messages, string, ResourcesOf<typeof deps>>({
  deps,
  async run(work) {
    const ref: InteractionReference = await work.resources.start.start({ messages: work.input });
    const outcome = await work.resources.feedback.wait({ reference: ref, waitMs: 100 });
    await work.resources.feedback.follow(
      { reference: ref, waitMs: 100 },
      {
        delta(item) {
          const cursor: InteractionCursor = item.cursor;
          const preview: string = item.value;
          // @ts-expect-error A sequence cursor is not an accepted model result.
          const text: string = cursor;
          // @ts-expect-error Model preview is text, not a provider envelope.
          item.value.content;
          void [cursor, preview, text];
        },
      },
    );
    if (outcome.kind === 'received') {
      const text: string = outcome.feedback.payload.text;
      // @ts-expect-error Complete feedback has a text field, not content.
      outcome.feedback.payload.content;
      return text;
    }
    // @ts-expect-error Reading does not grant permission to start another exchange.
    work.resources.feedback.start({ messages: work.input });
    // @ts-expect-error A local wait uses a reference rather than message history.
    work.resources.feedback.wait({ reference: work.input, waitMs: 100 });
    throw new Error('not available');
  },
});
createConversationScene(startAndRead);
const scene = createConversationScene(createInteractionAnswer({ waitMs: 100 }));
scene.run = async (work) => {
  const history: Messages = [{ role: 'user', content: work.input }];
  const text: string = await work.children.answer.invoke(history);
  // @ts-expect-error The registered answer consumes messages, not the Scene's raw string input.
  work.children.answer.invoke(work.input);
  return text;
};

const badResult = new Node<Messages, number>({ run: () => 42 });
// @ts-expect-error A conversation answer must deliver complete text.
createConversationScene(badResult);
const badInput = new Node<string, string>({ run: (work) => work.input });
// @ts-expect-error An answer must consume the fixed message prefix.
createConversationScene(badInput);
const badDelta = new Node<Messages, string, {}, number>({ run: () => 'answer', output: { result: String, delta: Number } });
// @ts-expect-error The conversation preview cannot accept numerical deltas.
createConversationScene(badDelta);
const streamingAnswer = new Node<Messages, string, {}, string>({ run: () => 'answer', output: { result: String, delta: String } });
createConversationScene(streamingAnswer);

// @ts-expect-error Local waiting configuration uses a numerical duration.
createInteractionAnswer({ waitMs: '100' });
// @ts-expect-error Reply reader input configuration is a numerical duration.
createCompletionReplyNode({ waitMs: 100 });
