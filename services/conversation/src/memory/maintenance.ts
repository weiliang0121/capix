import { MemoryResource } from '@capix/memory';
import type { ResourcesOf } from '@capix/resources';
import { Group } from '@capix/structure';
import type { AcceptedConversationMessage } from '../scene.js';
import { ConversationViewResource } from '../materials/view.js';
import { ConversationMemoryResource } from './context.js';
import { createMemoryProposal } from './proposal.js';

/** An optional service policy, composed with message inclusion by an ordinary parent Group. */
export function createMemoryMaintenance() {
  const deps = { context: ConversationMemoryResource.request(), memories: MemoryResource.apply.request(), view: ConversationViewResource.manage.request() };
  const maintain = new Group<AcceptedConversationMessage, void, ResourcesOf<typeof deps>>({ name: 'maintain-conversation-memories', deps }).add({ propose: createMemoryProposal() });
  maintain.run = async (work) => {
    if (work.input.message?.role === 'user') return;
    const context = await work.resources.context.capture(work.input);
    if (work.resources.view.transcriptId !== context.basis.transcriptId || work.resources.view.memoriesId !== context.basis.memoriesId) throw new Error('Memory maintenance View belongs to different content entities');
    const proposal = await work.children.propose.invoke(context, {
      result: {
        succeeded: (changes) => ({ status: 'ready' as const, changes }),
        failed: () => ({ status: 'skipped' as const }),
      },
    });
    // Only receivable proposal failures skip extraction; returned failed and parent handled remain distinct facts.
    // This is distinct from a successful empty proposal, which still checks the captured basis.
    if (proposal.status === 'skipped') return;
    // The resource checks this exact collection and sequence at its synchronous write boundary.
    const applied = work.resources.memories.apply(proposal.changes, context.basis);
    const existing = new Set(context.memories.map((memory) => memory.id));
    const additions = applied.items.filter((memory) => !existing.has(memory.id)).map((memory) => ({ source: 'memories' as const, key: memory.id }));
    // Updating an inactive memory does not reactivate it. Inclusion is a distinct formal change.
    if (additions.length) work.resources.view.include(additions);
  };
  return maintain;
}
