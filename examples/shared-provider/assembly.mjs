import { CompletionInteraction, CompletionInteractionResource, CompletionResource, ConversationViewResource, createCompletionNode, createCompletionStartNode, createCompletionReplyNode, createConversationScene, createMaterialAnswer, createMaterialPreparation, createMessageInclusion } from '@capix/conversation-service';
import { createConversationInteractions } from '@capix/conversation-service/assembly';
import { Memories } from '@weiliang0121/capix-memory';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Group, Scene } from '@weiliang0121/capix-structure';
import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';
import { View } from '@weiliang0121/capix-view';

// This experiment retains formally returned references in a private host resource.
// It is deliberately in memory: sending and retaining a reference are not atomic,
// and cancellation before this handoff does not promise a recoverable reference.
const References = new ResourceOffer({
  name: 'example.completion-references',
  methods: {
    remember(references, reference) {
      references.push(Object.freeze({ id: reference.id, contract: reference.contract }));
      return reference;
    },
  },
});

function retainedCompletion() {
  const completion = new Group({
    name: 'retain-then-read-completion',
    deps: { references: References.request() },
    output: { result: (value) => value, delta: (value) => value },
  }).add({ send: createCompletionStartNode(), read: createCompletionReplyNode() });
  completion.run = async (work) => {
    const reference = await work.children.send.invoke(work.input, {
      result: { succeeded: (reference) => work.resources.references.remember(reference) },
    });
    return work.children.read.invoke(reference, { delta: (value) => work.output.emit(value) });
  };
  return completion;
}

/** Same provider origin, independent content, registry, tree, Runner and exchanges. */
export function createSession({ model, label, mode = 'direct', persistence }) {
  if (!['direct', 'interaction'].includes(mode)) throw new TypeError('Unknown example completion mode');
  const transcript = new Transcript([{ role: 'user', content: `${label}:private-history` }]);
  const memories = new Memories(transcript);
  const [memory] = memories.apply([{ action: 'create', memoryId: null, change: 'Seed private experiment material', sourceIndexes: [0], result: { topic: 'private fixture', content: `${label}:private-memory`, sourceIndexes: [0] } }]);
  const view = new View({
    revision: 0,
    sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } },
    members: [
      { source: 'messages', key: 0 },
      { source: 'memories', key: memory.id },
    ],
  });
  const content = { transcript, memories, view };
  const materials = new Resource(content);
  const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(materials, ConversationViewResource.read).register(materials, ConversationViewResource.manage);
  const references = [];
  const interactions = mode === 'interaction' ? createConversationInteractions(model, persistence) : undefined;
  if (interactions) {
    resources.register(new Resource(references), References).registerInteraction(CompletionInteractionResource.start, CompletionInteraction).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
  } else resources.register(new Resource(model), CompletionResource);
  const completion = interactions ? retainedCompletion() : createCompletionNode();
  const scene = createConversationScene(createMaterialAnswer(completion), createMaterialPreparation(), createMessageInclusion());
  const runner = new Runner(scene, resources, interactions).build();
  return { runner, resources, content, references, interactions };
}

/** Read an already-established exchange; no dispatch or assistant-message write. */
export function createFeedbackReader(interactions) {
  const scene = new Scene({ output: { result: (value) => value, delta: (value) => value } }).add({ read: createCompletionReplyNode() });
  scene.run = (work) => work.children.read.invoke(work.input, { delta: (value) => work.output.emit(value) });
  return new Runner(scene, new Resources().registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction), interactions).build();
}
