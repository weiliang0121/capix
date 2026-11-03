import { CompletionResource, createConversationScene, createHistoryAnswer, HistoryResource } from '@capix/conversation-service';
import type { ModelProvider, ModelReply, ModelRequest } from '@capix/model-provider';
import type { Message } from '@capix/protocol';
import { Resource, type ResourcesOf } from '@capix/resources';
import { Node } from '@capix/structure';
import { Resources, Runner } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/transcript';

const model: ModelProvider = {
  async complete(request, controls) {
    const signal: AbortSignal | undefined = controls?.signal;
    const input: ModelRequest = request;
    void [signal, input];
    return { id: 'typed', model: 'offline', text: 'answer', finishReason: 'stop', usage: null };
  },
};
const entity = new Resource(new Transcript());
const resources = new Resources().register(entity, TranscriptResource.append).register(entity, HistoryResource).register(new Resource(model), CompletionResource);
const scene = createConversationScene(createHistoryAnswer());
const runner = new Runner(scene, resources).build();
const result: Promise<string> = runner.run('总结此前对话。');
// @ts-expect-error The conversation host still accepts a text submission, not a message prefix.
runner.run([{ role: 'user', content: 'question' }]);
// @ts-expect-error A generated conversation answer is text, not a provider envelope.
const wrongResult: Promise<ModelReply> = runner.run('question');

const deps = { model: CompletionResource.request() };
const requester = new Node<ModelRequest, ModelReply, ResourcesOf<typeof deps>>({
  deps,
  run(work) {
    const completion: Promise<ModelReply> = work.resources.model.complete(work.input);
    work.resources.model.complete({ messages: [{ role: 'system', content: 'Provider instructions.' }], responseFormat: 'json_object' });
    // @ts-expect-error The completion resource needs a structured request.
    work.resources.model.complete('prompt');
    // @ts-expect-error A provider reply is not implicitly reduced to its text.
    const text: Promise<string> = work.resources.model.complete(work.input);
    // @ts-expect-error A dependency does not grant a transcript writer.
    work.resources.messages.append([]);
    void text;
    return completion;
  },
});

scene.run = async (work) => {
  const prefix: readonly Readonly<Message>[] = [{ role: 'user', content: work.input }];
  const value: string = await work.children.answer.invoke(prefix);
  // @ts-expect-error The answer Group consumes an accepted message prefix, not a raw string.
  await work.children.answer.invoke(work.input);
  // @ts-expect-error Parent resources do not inherit the decision/summary model dependency.
  work.resources.model.complete({ messages: [] });
  return value;
};
void [result, wrongResult, requester];
