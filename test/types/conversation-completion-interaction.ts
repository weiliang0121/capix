import { CompletionInteraction, CompletionInteractionResource, createCompletionNode, createCompletionStartNode, createCompletionReplyNode, createInteractionCompletion, createMaterialAnswer, createConversationScene, createMaterialPreparation } from '@capix/conversation-service';
import { Interactions, type InteractionReference } from '@capix/interaction';
import type { ModelReply, ModelRequest } from '@capix/model-provider';
import type { ResourcesOf } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Group, Node, Scene } from '@capix/structure';

const request: ModelRequest = { messages: [{ role: 'system', content: 'instruction' }], stream: true, responseFormat: 'json_object', maxTokens: 100, temperature: 0 };
const reply: ModelReply = { id: 'completion', model: 'model', text: 'answer', finishReason: 'stop', usage: null };
const interactions = new Interactions().register(CompletionInteraction, {
  send(value, { publish }) {
    const typed: Readonly<ModelRequest> = value;
    publish('text');
    // @ts-expect-error Process feedback is text, not a final reply.
    publish(reply);
    // @ts-expect-error Stored messages are immutable values.
    value.messages.push({ role: 'user', content: 'mutated' });
    void typed;
    return reply;
  },
});
// @ts-expect-error A full completion contract cannot be supplied by a text-only sender.
new Interactions().register(CompletionInteraction, { send: () => 'only text' });

const start = new Runner(new Scene(createCompletionStartNode()), new Resources().registerInteraction(CompletionInteractionResource.start, CompletionInteraction), interactions).build();
const reference: Promise<InteractionReference> = start.run(request);
// @ts-expect-error Starting requires a full model request, not a messages array.
start.run(request.messages);
// @ts-expect-error Starting returns an exchange identity, not a completed response.
const premature: Promise<ModelReply> = start.run(request);

const read = new Runner(new Scene(createCompletionReplyNode()), new Resources().registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction), interactions).build();
const result: Promise<ModelReply> = read.run({ id: 'saved', contract: CompletionInteraction.key });
// @ts-expect-error A reply reader cannot accept a new request.
read.run(request);
// @ts-expect-error Reply reads preserve metadata and do not return a bare string.
const text: Promise<string> = read.run({ id: 'saved', contract: CompletionInteraction.key });

const deps = { feedback: CompletionInteractionResource.feedback.request() };
const follower = new Node<InteractionReference, ModelReply, ResourcesOf<typeof deps>, string>({
  deps,
  async run(work) {
    const feedback = await work.resources.feedback.follow(
      { reference: work.input, waitMs: 1000 },
      {
        delta(item) {
          const text: string = item.value;
          const position: number = item.cursor.sequence;
          // @ts-expect-error Preview chunks carry positions and text, not final usage.
          item.usage;
          work.output.emit(text);
          void position;
        },
      },
    );
    // @ts-expect-error Reading permission cannot send requests.
    work.resources.feedback.start(request);
    if (feedback.kind !== 'received') throw new Error('Not ready');
    const reason: string = feedback.feedback.payload.finishReason;
    void reason;
    return feedback.feedback.payload;
  },
});

const completion = createInteractionCompletion();
const material = createMaterialAnswer(completion);
createConversationScene(material, createMaterialPreparation());
createMaterialAnswer(createCompletionNode());
createMaterialAnswer(new Node<ModelRequest, ModelReply, {}, string>({ run: () => reply }));
createMaterialAnswer(new Group<ModelRequest, ModelReply, {}, string>({ run: () => reply }));
// @ts-expect-error A completion replacement must return complete metadata.
createMaterialAnswer(new Node<ModelRequest, string, {}, string>({ run: () => 'text' }));
// @ts-expect-error A replacement cannot change the input to plain text.
createMaterialAnswer(new Node<string, ModelReply, {}, string>({ run: () => reply }));
// @ts-expect-error A replacement cannot send non-text preview deltas.
createMaterialAnswer(new Node<ModelRequest, ModelReply, {}, number>({ run: () => reply }));

const outputScene = new Scene<ModelRequest, ModelReply, {}, string>().add({ completion: createInteractionCompletion() });
outputScene.run = (work) => work.children.completion.invoke(work.input, { delta: (value) => work.output.emit(value) });
const output = new Runner(outputScene, new Resources(), interactions);
output.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') {
      const value: string = event.delta;
      // @ts-expect-error Completion preview is text.
      const wrong: number = event.delta;
      void [value, wrong];
    }
    if (event.kind === 'completed') {
      const full: ModelReply = event.result;
      void full;
    }
  },
});
void [reference, premature, result, text, follower];
