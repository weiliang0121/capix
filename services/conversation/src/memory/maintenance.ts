import type { MemoryChange } from '@capix/memory';
import { isDeepStrictEqual } from 'node:util';
import type { ResourcesOf } from '@capix/resources';
import { Group, checkpointPoint, childReference, reception, type GroupWork, type CheckpointFacts } from '@capix/structure';
import { z } from 'zod';
import type { ConversationCompletion } from '../completion.js';
import type { AcceptedConversationMessage } from '../scene.js';
import { ConversationViewResource } from '../materials/view.js';
import { acceptedMessageCodec, codec, voidCodec } from '../recovery/codecs.js';
import { ConversationMemoryResource, type ConversationMemoryContext } from './context.js';
import { createMemoryProposal } from './proposal.js';
import { createMemoryApplication } from './apply.js';
import { memoryChangesSchema, memoryContextCodec } from './codecs.js';

type Proposal = { readonly status: 'ready'; readonly changes: readonly MemoryChange[] } | { readonly status: 'skipped' };
const proposalSchema: z.ZodType<Proposal> = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ready'), changes: memoryChangesSchema }), z.strictObject({ status: z.literal('skipped') })]);
const proposalCodec = codec(proposalSchema);

/** Extraction policy, fixed effect and View inclusion remain distinct ordinary operations. */
export function createMemoryMaintenance(completion?: ConversationCompletion, maxTokens?: number) {
  const deps = { context: ConversationMemoryResource.request(), view: ConversationViewResource.manage.request() };
  const viewDeps = { view: ConversationViewResource.manage.request() };
  const propose = createMemoryProposal(completion, maxTokens);
  const apply = createMemoryApplication();
  const received = reception(propose, { ...proposalCodec, check: (value: unknown) => proposalSchema.parse(value) });
  const result = { succeeded: (changes: readonly MemoryChange[]): Proposal => ({ status: 'ready', changes }), failed: (): Proposal => ({ status: 'skipped' }) };
  type ViewWork = Pick<GroupWork<AcceptedConversationMessage, void, ResourcesOf<typeof viewDeps>>, 'checkpoint' | 'resources'>;
  type ApplyWork = GroupWork<AcceptedConversationMessage, void, ResourcesOf<typeof viewDeps>, typeof apply>;
  function checkContext(context: ConversationMemoryContext, input: AcceptedConversationMessage) {
    if (context.basis.transcriptId !== input.transcriptId || context.acceptedIndex !== input.index || !isDeepStrictEqual(context.messages.at(-1)?.message, input.message)) throw new Error('Memory checkpoint context differs from its accepted assistant message');
  }
  function acceptedProposal(facts: CheckpointFacts<AcceptedConversationMessage>) {
    const child = facts.children.requireUnique(propose, { parentRound: 1 });
    checkContext(child.input, facts.input);
    if (child.key !== 'propose' || child.order !== 0) throw new Error('Memory checkpoint changed its proposal call');
    const value = child.reception.status === 'handled' ? facts.children.handled(child.ref, received) : facts.children.accepted(child.ref, received);
    if (value.status === 'ready' ? child.returned?.status !== 'succeeded' || !isDeepStrictEqual(value.changes, child.returned.output) : child.returned?.status !== 'failed' || child.reception.status !== 'handled') throw new Error('Saved memory reception differs from its proposal delivery');
    return { value, context: child.input };
  }
  function checkedApplication(facts: CheckpointFacts<AcceptedConversationMessage>) {
    const { value, context } = acceptedProposal(facts);
    const child = facts.children.requireUnique(apply, { parentRound: 1 });
    if (value.status !== 'ready' || facts.children.values().length !== 2 || child.key !== 'apply' || child.order !== 1 || !isDeepStrictEqual(child.input, { basis: context.basis, changes: value.changes, existingIds: context.memories.map((item) => item.id) })) throw new Error('Saved memory application differs from its accepted proposal');
    return child;
  }
  const completed = checkpointPoint<'group', AcceptedConversationMessage, void>()({
    name: 'completed',
    state: voidCodec,
    references: {},
    check(_state, facts) {
      if (facts.input.message.role === 'user') {
        if (facts.children.values().length) throw new Error('User maintenance cannot create memory children');
        return;
      }
      const { value } = acceptedProposal(facts);
      if (value.status === 'skipped') {
        if (facts.children.values().length !== 1) throw new Error('Skipped maintenance cannot apply memory');
        return;
      }
      const child = checkedApplication(facts);
      if (child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted' || !isDeepStrictEqual(child.reception.value, child.returned.output)) throw new Error('Completed maintenance requires its accepted application');
    },
    resume: { run() {} },
  });
  function finish(work: ViewWork, ids: readonly string[]) {
    // Explicit ensure-members policy. Host eligibility excludes later View/content edits.
    if (ids.length) work.resources.view.include(ids.map((key) => ({ source: 'memories' as const, key })));
    work.checkpoint?.({ point: completed, state: undefined, refs: {} });
  }
  const applying = checkpointPoint<'group', AcceptedConversationMessage, void>()({
    name: 'applyWaiting',
    state: voidCodec,
    references: { apply: childReference(apply) },
    check(_state, facts) {
      if (checkedApplication(facts).returned) throw new Error('Waiting memory application already returned');
    },
    resume: {
      deps: viewDeps,
      uses: [apply],
      async run(work, _state, refs) {
        const ids = await work.children.resume(refs.apply).invoke();
        finish(work, ids);
      },
    },
  });
  async function continueProposal(work: ApplyWork, context: ConversationMemoryContext, proposal: Proposal) {
    if (proposal.status === 'skipped') {
      work.checkpoint?.({ point: completed, state: undefined, refs: {} });
      return;
    }
    const call = work.children.create(apply, { basis: context.basis, changes: proposal.changes, existingIds: context.memories.map((item) => item.id) }, { key: 'apply' });
    work.checkpoint?.({ point: applying, state: undefined, refs: { apply: call.ref } });
    finish(work, await call.invoke());
  }
  const accepted = checkpointPoint<'group', AcceptedConversationMessage, void>()({
    name: 'proposalReceived',
    state: memoryContextCodec,
    references: { propose: childReference(propose) },
    check(context, facts) {
      if (facts.children.values().length !== 1 || !isDeepStrictEqual(context, acceptedProposal(facts).context)) throw new Error('Memory checkpoint changed its original extraction context');
    },
    resume: {
      deps: viewDeps,
      uses: [apply],
      async run(work, context, refs) {
        const fact = work.children.facts.get(refs.propose);
        const proposal = fact.reception.status === 'handled' ? work.children.facts.handled(refs.propose, received) : work.children.facts.accepted(refs.propose, received);
        await continueProposal(work, context, proposal);
      },
    },
  });
  const waiting = checkpointPoint<'group', AcceptedConversationMessage, void>()({
    name: 'proposalWaiting',
    state: memoryContextCodec,
    references: { propose: childReference(propose) },
    check(context, facts) {
      checkContext(context, facts.input);
      const child = facts.references.propose;
      if (facts.children.values().length !== 1 || child.key !== 'propose' || child.returned || !isDeepStrictEqual(child.input, context)) throw new Error('Memory proposal checkpoint changed its captured context');
    },
    resume: {
      deps: viewDeps,
      uses: [propose, apply],
      async run(work, context, refs) {
        const proposal = await work.children.resume(refs.propose).invoke({ reception: received, result });
        work.checkpoint?.({ point: accepted, state: context, refs });
        await continueProposal(work, context, proposal);
      },
    },
  });
  const maintain = new Group<AcceptedConversationMessage, void, ResourcesOf<typeof deps>>({
    name: 'maintain-conversation-memories',
    deps,
    checkpoint: { key: 'conversation.memory.maintenance', version: 1, input: acceptedMessageCodec, output: voidCodec, receptions: [received], points: [waiting, accepted, applying, completed] },
  }).add({ propose, apply });
  maintain.run = async (work) => {
    if (work.input.message?.role === 'user') {
      work.checkpoint?.({ point: completed, state: undefined, refs: {} });
      return;
    }
    const context = await work.resources.context.capture(work.input);
    if (work.resources.view.transcriptId !== context.basis.transcriptId || work.resources.view.memoriesId !== context.basis.memoriesId) throw new Error('Memory maintenance View belongs to different content entities');
    const call = work.children.create(propose, context, { key: 'propose' });
    work.checkpoint?.({ point: waiting, state: context, refs: { propose: call.ref } });
    // Only receivable proposal failures skip extraction; protected failures and cancellation propagate.
    const proposal = await call.invoke({ reception: received, result });
    work.checkpoint?.({ point: accepted, state: context, refs: { propose: call.ref } });
    await continueProposal(work, context, proposal);
  };
  return maintain;
}
