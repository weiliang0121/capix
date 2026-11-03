import { ConversationViewResource, createConversationScene, createMaterialAnswer, createMaterialPreparation, createMessageInclusion, type AcceptedConversationMessage, type ConversationMaintenance, type ConversationMaterialSources, type ConversationViewManagementSource } from '@capix/conversation-service';
import { Memories } from '@capix/memory';
import { Resource, type ResourcesOf } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Group, Node } from '@capix/structure';
import { Transcript, TranscriptResource } from '@capix/transcript';
import { View, type ViewPersistence } from '@capix/view';

const transcript = new Transcript();
const memories = new Memories(transcript);
const view = new View<ConversationMaterialSources>({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] });
const persistence: ViewPersistence<ConversationMaterialSources> = {
  commit(change) {
    const expectedRevision: number = change.previous.revision;
    const nextRevision: number = change.state.revision;
    const sourceId: string | undefined = change.checkedSources.messages?.id;
    // @ts-expect-error Persistence receives immutable state.
    change.state.revision++;
    void [expectedRevision, nextRevision, sourceId];
  },
};
const origin: ConversationViewManagementSource = { transcript, memories, view, persistence };
const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(new Resource(origin), ConversationViewResource.read).register(new Resource(origin), ConversationViewResource.manage);
const inclusion: ConversationMaintenance = createMessageInclusion();
const runner = new Runner(createConversationScene(createMaterialAnswer(), createMaterialPreparation(), inclusion), resources).build();
const result: Promise<string> = runner.run('question');

const deps = { view: ConversationViewResource.manage.request() };
const maintain = new Node<AcceptedConversationMessage, void, ResourcesOf<typeof deps>>({
  deps,
  run(work) {
    const transcriptId: string = work.input.transcriptId;
    const index: number = work.input.index;
    const role: 'user' | 'assistant' = work.input.message.role;
    const content: string = work.input.message.content;
    const sameTranscript: boolean = work.resources.view.transcriptId === transcriptId;
    const reference = { source: 'messages', key: index } as const;
    const present: boolean = work.resources.view.has(reference);
    const state = work.resources.view.include([reference, { source: 'memories', key: 'memory-id' }]);
    work.resources.view.exclude([reference]);
    const current = work.resources.view.index();
    work.resources.view.apply({ basis: current.basis, members: state.members });
    const snapshot = work.resources.view.capture();
    for (const entry of snapshot.entries) {
      if (entry.source === 'messages') {
        const position: number = entry.key;
        const text: string = entry.value.content;
        void [position, text];
      } else {
        const id: string = entry.key;
        const indexes: readonly number[] = entry.value.sourceIndexes;
        void [id, indexes];
      }
    }
    // @ts-expect-error The formal input does not permit rewriting message content.
    work.input.message.content = 'rewritten';
    // @ts-expect-error Message references require numeric transcript positions.
    work.resources.view.include([{ source: 'messages', key: '0' }]);
    // @ts-expect-error Memory references require actual memory IDs.
    work.resources.view.exclude([{ source: 'memories', key: 0 }]);
    // @ts-expect-error Unregistered source slots are not part of this manager.
    work.resources.view.has({ source: 'documents', key: 'doc' });
    // @ts-expect-error Replacement requires the complete checked basis.
    work.resources.view.apply({ members: [reference] });
    // @ts-expect-error Membership snapshots cannot be mutated in place.
    work.resources.view.members().push(reference);
    // @ts-expect-error Managing membership does not grant Transcript writes.
    work.resources.view.transcript.append({ role: 'assistant', content: 'hidden' });
    // @ts-expect-error Managing membership does not grant Memory writes.
    work.resources.view.memories.apply([]);
    // @ts-expect-error Persistence remains a host-owned port.
    work.resources.view.persistence.commit({});
    void [role, content, sameTranscript, present];
  },
});
const group = new Group<AcceptedConversationMessage, void>().add({ maintain });
group.run = (work) => work.children.maintain.invoke(work.input);
const groupPolicy: ConversationMaintenance = group;
createConversationScene(undefined, undefined, groupPolicy);

const readDeps = { view: ConversationViewResource.read.request() };
const readOnly = new Node<AcceptedConversationMessage, void, ResourcesOf<typeof readDeps>>({
  deps: readDeps,
  async run(work) {
    await work.resources.view.capture();
    work.resources.view.has({ source: 'messages', key: work.input.index });
    // @ts-expect-error Read permission does not allow inclusion.
    work.resources.view.include([]);
    // @ts-expect-error Read permission does not allow exclusion.
    work.resources.view.exclude([]);
    // @ts-expect-error Read permission does not allow replacement.
    work.resources.view.apply({});
  },
});
const wrongInput = new Node<string, void>({ run() {} });
// @ts-expect-error Maintenance must accept the formal append identity, not raw host input.
createConversationScene(createMaterialAnswer(), createMaterialPreparation(), wrongInput);
const wrongOutput = new Node<AcceptedConversationMessage, string>({ run: () => 'not maintenance output' });
// @ts-expect-error Maintenance is a void operation, not another answer stage.
createConversationScene(createMaterialAnswer(), createMaterialPreparation(), wrongOutput);
// @ts-expect-error A callback is not an owned Node or Group structure.
createConversationScene(undefined, undefined, (_accepted: AcceptedConversationMessage) => undefined);
// @ts-expect-error Management persistence must commit synchronously.
const asyncPersistence: ViewPersistence<ConversationMaterialSources> = { commit: async () => undefined };
// @ts-expect-error Source identity cannot be inferred from a View-local numeric position.
const missingSource: AcceptedConversationMessage = { index: 0, message: { role: 'user', content: 'question' } };
void [result, readOnly, asyncPersistence, missingSource];
