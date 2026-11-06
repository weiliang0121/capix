import { modelReplyText } from '@capix/model-provider';
import { CompletionResource, ConversationViewResource, createConversationScene, createMaterialAnswer, createMaterialPreparation, type AcceptedConversationMessage, type ConversationMaterialInput, type ConversationMaterialSources } from '@capix/conversation-service';
import { Memories } from '@capix/memory';
import { Resource, type ResourcesOf } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Node } from '@capix/structure';
import { Transcript, TranscriptResource } from '@capix/transcript';
import { View } from '@capix/view';

const transcript = new Transcript();
const memories = new Memories(transcript);
const view = new View<ConversationMaterialSources>({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] });
const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(new Resource({ view, transcript, memories }), ConversationViewResource.read);
const answer = new Node<ConversationMaterialInput, string, {}, string>({
  run(work) {
    const query: string = work.input.query.content;
    const queryIndex: number = work.input.query.index;
    const source: string = work.input.query.transcriptId;
    for (const entry of work.input.materials.entries) {
      if (entry.source === 'messages') {
        const index: number = entry.key;
        const role: 'user' | 'assistant' = entry.value.role;
        // @ts-expect-error Message entries are not memory entities.
        const topic = entry.value.topic;
        void [index, role, topic];
      } else {
        const id: string = entry.key;
        const topic: string = entry.value.topic;
        const evidence: readonly number[] = entry.value.sourceIndexes;
        // @ts-expect-error Memory identity is not a transcript position.
        const position: number = entry.key;
        void [id, topic, evidence, position];
      }
    }
    // @ts-expect-error A captured input does not grant the source entity or writer.
    work.resources.messages.append([]);
    // @ts-expect-error Business material is immutable.
    work.input.materials.entries.push({ source: 'messages', key: 0, value: { role: 'user', content: 'changed' } });
    void [queryIndex, source];
    return query;
  },
});
const scene = createConversationScene(answer, createMaterialPreparation());
const runner = new Runner(scene, resources).build();
const response: Promise<string> = runner.run('question');
// @ts-expect-error Host submissions are text, not prepared business material.
runner.run({ query: 'question', materials: [] });

const deps = { view: ConversationViewResource.read.request() };
const readOnly = new Node<string, string, ResourcesOf<typeof deps>>({
  deps,
  async run(work) {
    const captured = await work.resources.view.capture();
    const revision: number = captured.basis.viewRevision;
    // @ts-expect-error Read access does not grant membership changes.
    work.resources.view.apply({ members: [] });
    // @ts-expect-error Read access does not expose raw source entities.
    work.resources.view.transcript.append({ role: 'user', content: 'hidden write' });
    void revision;
    return work.input;
  },
});

const accepted: AcceptedConversationMessage = { transcriptId: transcript.id, index: 0, message: { role: 'user', content: 'question' } };
// @ts-expect-error Accepted source identity is required independently of the selected View.
const missingSource: AcceptedConversationMessage = { index: 0, message: { role: 'user', content: 'question' } };
const wrong = new Node<number, string, {}, string>({ run: (work) => String(work.input) });
// @ts-expect-error Preparation and answer must agree on the actual input contract.
createConversationScene(wrong, createMaterialPreparation());
createConversationScene(createMaterialAnswer(), createMaterialPreparation());

const modelDeps = { model: CompletionResource.request() };
const streamed = new Node<string, string, ResourcesOf<typeof modelDeps>, string>({
  deps: modelDeps,
  async run(work) {
    const request = { messages: [{ role: 'user' as const, content: work.input }], stream: true };
    const reply = await work.resources.model.complete(request, {
      delta: (value) => {
        const text: string = value;
        work.output.emit(text);
        // @ts-expect-error Streamed resource deltas are text, not final provider replies.
        value.finishReason;
      },
    });
    const finishReason: string = reply.termination.reason;
    // @ts-expect-error A resource delta consumer cannot claim numeric chunks.
    work.resources.model.complete(request, { delta: (value: number) => void value });
    void finishReason;
    return modelReplyText(reply);
  },
});
void [response, accepted, missingSource, readOnly, streamed];
