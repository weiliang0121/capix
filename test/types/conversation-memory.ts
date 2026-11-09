import { ConversationMemoryResource, ConversationViewResource, createMemoryMaintenance, createMessageInclusion, createConversationScene, createMaterialPreparation, createMaterialAnswer, type AcceptedConversationMessage, type ConversationMaintenance, type ConversationMemoryContext } from '@capix/conversation-service';
import { Memories, MemoryResource, type MemoryApplication, type MemoryBasis, type MemoryState } from '@weiliang0121/capix-memory';
import { Resource, Resources, type ResourcesOf } from '@weiliang0121/capix-resources';
import { Group, Node } from '@weiliang0121/capix-structure';
import { Transcript } from '@weiliang0121/capix-transcript';

const transcript = new Transcript();
const memories = new Memories(transcript);
new Resources().register(new Resource(memories), ConversationMemoryResource).register(new Resource(memories), MemoryResource.apply);
// @ts-expect-error The capture resource requires a memory entity, not arbitrary messages.
new Resources().register(new Resource(transcript), ConversationMemoryResource);

const maintain: ConversationMaintenance = createMemoryMaintenance();
const all = new Group<AcceptedConversationMessage, void>().add({ messages: createMessageInclusion(), memories: maintain });
all.run = async (work) => {
  await work.children.messages.invoke(work.input);
  await work.children.memories.invoke(work.input);
};
createConversationScene(createMaterialAnswer(), createMaterialPreparation(), all);

const deps = { context: ConversationMemoryResource.request(), memories: MemoryResource.apply.request(), view: ConversationViewResource.manage.request() };
const custom = new Node<AcceptedConversationMessage, void, ResourcesOf<typeof deps>>({
  deps,
  async run(work) {
    const context: ConversationMemoryContext = await work.resources.context.capture(work.input);
    const expected: MemoryBasis = context.basis;
    const response: MemoryApplication = work.resources.memories.apply([], expected);
    const id: string = response.memoriesId;
    const owner: string = response.transcriptId;
    const memory: Readonly<MemoryState> | undefined = response.items[0];
    const stamp: number = response.sequence;
    if (memory) work.resources.view.include([{ source: 'memories', key: memory.id }]);
    const sameMemories: boolean = work.resources.view.memoriesId === expected.memoriesId;
    // @ts-expect-error Capture does not expose a write endpoint.
    work.resources.context.apply([]);
    // @ts-expect-error A capture requires formal append identity and content.
    work.resources.context.capture('raw input');
    // @ts-expect-error A sequence alone does not identify the memory source.
    work.resources.memories.apply([], { sequence: 0 });
    // @ts-expect-error Model results cannot mutate the fixed source basis.
    context.basis.sequence++;
    // @ts-expect-error Captured entity snapshots are immutable.
    context.memories.push({});
    // @ts-expect-error Write results do not expose live Memory mutation methods.
    response.items[0]?.snapshot();
    // @ts-expect-error Applied IDs cannot be rewritten by the caller.
    response.items[0]!.id = 'forged';
    // @ts-expect-error The new maintenance does not require hidden model state on work.
    work.model.complete({});
    void [id, owner, stamp, sameMemories];
  },
});
void custom;
