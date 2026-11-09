import { resolveConversationOutputBudget, type ConversationOutputBudget } from '../model/budget.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { CheckpointHead, CheckpointStore } from '@weiliang0121/capix-checkpoint';
import type { InteractionState } from '@weiliang0121/capix-interaction';
import type { ModelReply, ModelRequest } from '@weiliang0121/capix-model-provider';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import type { ViewReference, ViewState } from '@weiliang0121/capix-view';
import { z } from 'zod';
import type { ConversationMaterialSources, ConversationViewSource } from '../materials/view.js';
import { memoryApplySchema } from '../memory/codecs.js';
import type { AcceptedConversationMessage } from '../scene.js';
import { acceptedMessageSchema, codec, count, identity } from './codecs.js';
import { memoryStateSchema, referenceSchema } from './model-codecs.js';
import { modelRequestSchema } from '../model/completion-contract.js';

const source = z.strictObject({ id: identity, scope: identity });
const viewSchema = z.strictObject({ revision: count, sources: z.strictObject({ messages: source, memories: source }), members: z.array(z.discriminatedUnion('source', [z.strictObject({ source: z.literal('messages'), key: count }), z.strictObject({ source: z.literal('memories'), key: identity })])) });
export const recoveryBasisSchema = z.strictObject({
  configuration: identity,
  accepted: acceptedMessageSchema,
  transcript: z.strictObject({ revision: count, end: count, starts: z.array(count), digest: identity }),
  memories: z.strictObject({ id: identity, transcriptId: identity, sequence: count, items: z.array(memoryStateSchema) }),
  view: viewSchema,
});
export type ConversationRecoveryBasis = z.infer<typeof recoveryBasisSchema>;
export const recoveryBasisCodec = codec(recoveryBasisSchema);
export const conversationCheckpointKey = 'conversation.material-scene';

/** Only the default service policy uses this evidence. It grants no entity write authority. */
export const ConversationRecoveryResource = new ResourceOffer({
  name: 'conversation.recovery-basis',
  expose: (source: ConversationViewSource & { readonly configuration: string }, activity) => ({
    capture(accepted: AcceptedConversationMessage): ConversationRecoveryBasis {
      return activity.runSync('capture', {}, () => {
        const transcript = source.transcript.exportState();
        if (accepted.transcriptId !== transcript.id || accepted.index !== transcript.messages.length - 1 || accepted.message.role !== 'user' || !equal(accepted.message, transcript.messages[accepted.index])) throw changed('Recovery must start at its formally accepted input');
        const memories = source.memories.exportState();
        return recoveryBasisSchema.parse({ configuration: source.configuration, accepted, transcript: { revision: transcript.revision, end: transcript.messages.length, starts: transcript.starts, digest: digest(transcript.messages) }, memories: { id: memories.id, transcriptId: memories.transcriptId, sequence: memories.sequence, items: memories.items }, view: source.view.exportState() });
      });
    },
  }),
});

export interface RecoveryStore {
  readonly checkpoints: CheckpointStore & { listRoots(): readonly CheckpointHead[] };
  readonly interactions: { read(id: string): InteractionState<ModelRequest, ModelReply> | undefined };
  assertAvailable(): void;
}

/** Eligibility is checked again immediately before resume; listing is not a reservation. */
export function listConversationRecoveries(content: ConversationViewSource, store: RecoveryStore, configuration: string, outputBudget: Partial<ConversationOutputBudget> = {}) {
  store.assertAvailable();
  return store.checkpoints
    .listRoots()
    .filter((head) => head.image.contract.key === conversationCheckpointKey && !head.delivery)
    .map((head) => {
      const contextId = head.image.frame.owner.contextId;
      try {
        assertConversationRecovery(content, store, configuration, contextId, outputBudget);
        return { contextId, point: head.image.point, available: true as const };
      } catch (error) {
        return { contextId, point: head.image.point, available: false as const, reason: error instanceof Error ? error.message : 'Recovery evidence is unavailable' };
      }
    });
}

/** This is host admission, not a promise to resume an arbitrary custom strategy. */
export function assertConversationRecovery(content: ConversationViewSource, store: RecoveryStore, configuration: string, contextId: string, outputBudget: Partial<ConversationOutputBudget> = {}): { input: string; inputRevision: number; user: AcceptedConversationMessage; answer?: AcceptedConversationMessage } {
  store.assertAvailable();
  const root = requireConversationRecoveryRoot(store.checkpoints.read(contextId), { key: conversationCheckpointKey, version: 3 });
  const state = requireConversationRecoveryState(root, configuration, outputBudget);
  const { heads, handled } = recoverySubtree(root, store.checkpoints);
  assertCompletionRecovery(heads, handled, store.interactions);
  return assertConversationContentRecovery(content, root, state, heads);
}

export function requireConversationRecoveryRoot(root: CheckpointHead | undefined, contract: { readonly key: string; readonly version: number }): CheckpointHead {
  if (!root || root.delivery || !equal(root.image.contract, contract) || root.image.frame.owner.parentContextId !== undefined) throw changed('Only an unfinished compatible conversation checkpoint can resume');
  return root;
}

export function requireConversationRecoveryState(root: CheckpointHead, configuration: string, outputBudget: Partial<ConversationOutputBudget>) {
  const state = z.object({ basis: recoveryBasisSchema, outputBudget: z.strictObject({ answer: count, memory: count }), response: acceptedMessageSchema.optional() }).parse(root.image.state);
  const budget = resolveConversationOutputBudget(outputBudget);
  if (!equal(state.outputBudget, budget)) throw changed('Conversation output budget changed');
  const basis = state.basis;
  if (basis.configuration !== configuration || root.image.frame.input !== basis.accepted.message.content) throw changed('Conversation configuration or original input changed');
  return state;
}

export function assertCompletionRecovery(heads: ReadonlyMap<string, CheckpointHead>, handled: ReadonlySet<string>, interactions: RecoveryStore['interactions']): void {
  // This host resumes only exchanges whose full feedback survived. A restored
  // absence is missing recovery evidence, not an ordinary model proposal failure.
  // New steps reached after resume still start ordinary independent interactions.
  for (const head of heads.values()) {
    if (head.image.contract.key !== 'conversation.completion-start' || handled.has(head.image.frame.owner.contextId)) continue;
    const reference = referenceSchema.parse(head.image.state);
    const request = modelRequestSchema.parse(head.image.frame.input);
    const saved = interactions.read(reference.id);
    if (!saved || saved.contract !== reference.contract || !equal(saved.request, request) || !saved.feedback) throw changed('The saved model interaction has no matching durable feedback; it will not be sent again');
  }
}

export function assertConversationContentRecovery(content: ConversationViewSource, root: CheckpointHead, state: ReturnType<typeof requireConversationRecoveryState>, heads: ReadonlyMap<string, CheckpointHead>) {
  const contextId = root.image.frame.owner.contextId;
  const basis = state.basis;
  const { transcript, base, suffix } = assertConversationInputRecovery(content, root, state);
  const savedAnswer = root.image.frame.children.find((child) => child.key === 'answer');
  if (savedAnswer?.state.kind === 'returned' && savedAnswer.state.reception.kind === 'accepted' && !suffix.length) throw changed('The accepted answer effect is missing');
  if (suffix.length) {
    const effect = transcript.appends?.find((item) => item.receipt.start === base.end);
    const answer = root.image.frame.children.find((child) => child.key === 'answer');
    if (!effect || !answer || effect.request.operation.parentContextId !== contextId || effect.request.operation.childContextId !== answer.identity.contextId || effect.request.operation.position !== 'answer' || effect.receipt.count !== 1 || effect.receipt.revision !== transcript.revision || !equal(effect.request.messages, suffix) || suffix[0]?.role !== 'assistant') throw changed('The answer is not an exact fixed effect of this invocation');
  }
  const memories = content.memories.exportState();
  if (memories.id !== basis.memories.id || memories.transcriptId !== transcript.id) throw changed('Memory ownership changed');
  const expected = new Map(basis.memories.items.map((item) => [item.id, item]));
  const originalIds = new Set(expected.keys());
  let sequence = basis.memories.sequence;
  for (const effect of memories.applies ?? []) {
    if (effect.receipt.sequence <= basis.memories.sequence && !heads.has(effect.request.operation.contextId)) continue;
    if (effect.receipt.startSequence < basis.memories.sequence) throw changed('This invocation’s memory effect precedes its original basis');
    const head = heads.get(effect.request.operation.contextId);
    const input = head?.image.contract.key === 'conversation.memory.apply' ? memoryApplySchema.parse(head.image.frame.input) : undefined;
    if (!input || head?.image.contract.version !== 1 || effect.receipt.startSequence !== sequence || effect.request.operation.position !== 'memory-maintenance' || input.basis.memoriesId !== memories.id || input.basis.transcriptId !== transcript.id || input.basis.sequence !== basis.memories.sequence || !equal(input.changes, effect.request.changes) || !equal(new Set(input.existingIds), originalIds)) throw changed('Memory changes are not this invocation’s fixed batch');
    let applied = 0;
    for (const change of effect.request.changes) {
      if (change.action === 'update') {
        const previous = expected.get(change.memoryId);
        if (!previous) throw changed('Fixed memory target disappeared');
        if (equal(previous, { id: change.memoryId, ...change.result })) continue;
      }
      const id = effect.receipt.memoryIds[applied++];
      if (!id || (change.action === 'create' ? expected.has(id) : id !== change.memoryId)) throw changed('Fixed memory receipt has a different target');
      expected.set(id, { id, ...change.result });
    }
    if (applied !== effect.receipt.memoryIds.length || effect.receipt.sequence !== sequence + applied) throw changed('Fixed memory receipt has a different effect count');
    sequence = effect.receipt.sequence;
  }
  if (sequence !== memories.sequence || !equal([...expected.values()], memories.items)) throw changed('Memory content has changes outside the saved invocation');
  for (const head of heads.values()) {
    if (head.image.contract.key !== 'conversation.memory.apply' || (head.image.point !== 'completed' && !head.delivery)) continue;
    const input = memoryApplySchema.parse(head.image.frame.input);
    const effect = memories.applies?.find((item) => item.request.operation.contextId === head.image.frame.owner.contextId && item.request.operation.position === 'memory-maintenance');
    const ids = effect?.receipt.memoryIds.filter((id) => !input.existingIds.includes(id));
    if (!effect || !equal(input.changes, effect.request.changes) || !equal(head.image.state, ids) || (head.delivery?.status === 'succeeded' && !equal(head.delivery.output, ids))) throw changed('Completed memory application lacks its exact durable receipt');
  }

  // Default maintenance only ensures these members, in this order. It does not
  // restore an arbitrary old View or assume a membership commit was atomic with CP.
  const states: ViewState<ConversationMaterialSources>[] = [basis.view];
  const include = (refs: readonly ViewReference<ConversationMaterialSources>[]) => {
    const previous = states.at(-1)!;
    const added = refs.filter((ref) => !previous.members.some((item) => equal(item, ref)));
    if (added.length) states.push({ ...previous, revision: previous.revision + 1, members: [...previous.members, ...added] });
  };
  include([{ source: 'messages', key: basis.accepted.index }]);
  if (suffix.length) include([{ source: 'messages', key: base.end }]);
  include([...expected.keys()].filter((id) => !originalIds.has(id)).map((key) => ({ source: 'memories' as const, key })));
  if (!states.some((value) => equal(value, content.view.exportState()))) throw changed('View membership changed outside default maintenance');
  for (const head of heads.values()) {
    if (head.image.point !== 'completed' && head.delivery?.status !== 'succeeded') continue;
    if (head.image.contract.key === 'conversation.message.include') {
      const input = acceptedMessageSchema.parse(head.image.frame.input);
      if (!content.view.has({ source: 'messages', key: input.index })) throw changed('Completed message inclusion is absent from the View');
    }
    if (head.image.contract.key === 'conversation.memory.maintenance') {
      const input = acceptedMessageSchema.parse(head.image.frame.input);
      if (input.message.role === 'assistant' && [...expected.keys()].some((id) => !originalIds.has(id) && !content.view.has({ source: 'memories', key: id }))) throw changed('Completed memory inclusion is absent from the View');
    }
  }
  return { input: basis.accepted.message.content, inputRevision: base.revision, user: basis.accepted, ...(suffix[0] ? { answer: { transcriptId: transcript.id, index: base.end, message: suffix[0] } } : {}) };
}

/** Light candidate check; it does not certify model feedback, archive slots or memory effects. */
export function assertConversationInputRecovery(content: ConversationViewSource, _root: CheckpointHead, state: ReturnType<typeof requireConversationRecoveryState>) {
  const basis = state.basis;
  const transcript = content.transcript.exportState();
  const base = basis.transcript;
  if (transcript.id !== basis.accepted.transcriptId || base.end !== basis.accepted.index + 1 || basis.accepted.message.role !== 'user' || !equal(transcript.messages[basis.accepted.index], basis.accepted.message) || digest(transcript.messages.slice(0, base.end)) !== base.digest || !equal(transcript.starts, base.starts)) throw changed('Formal input or its preceding transcript changed');
  const suffix = transcript.messages.slice(base.end);
  if (suffix.length > 1 || transcript.revision !== base.revision + suffix.length) throw changed('A later submission or transcript change prevents continuation');
  if (state.response && (!suffix[0] || state.response.transcriptId !== transcript.id || state.response.index !== base.end || !equal(state.response.message, suffix[0]))) throw changed('The accepted answer is missing from durable content');
  return { transcript, base, suffix };
}

export function recoverySubtree(root: CheckpointHead, store: Pick<CheckpointStore, 'read'>): { heads: Map<string, CheckpointHead>; handled: Set<string> } {
  const heads = new Map<string, CheckpointHead>();
  const handled = new Set<string>();
  const queue = [{ head: root, handled: false }];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const head = current.head;
    const id = head.image.frame.owner.contextId;
    if (heads.has(id)) throw changed('Checkpoint relations contain a repeated scope');
    heads.set(id, head);
    if (current.handled) handled.add(id);
    for (const child of head.image.frame.children) {
      // A durable handled reception is the parent's adopted business result.
      // Its failed subtree is historical evidence, never a fresh recovery target.
      const wasHandled = current.handled || (child.state.kind === 'failed' && child.state.reception?.kind === 'handled');
      const saved = store.read(child.identity.contextId);
      if (!saved) {
        if (!wasHandled && child.state.kind === 'waiting') throw changed('A pending child has no saved checkpoint; its dispatch cannot be repeated');
        continue;
      }
      if (!equal(saved.image.frame.owner, child.identity) || saved.image.frame.owner.parentContextId !== id || !equal(saved.image.contract, child.contract) || !equal(saved.image.frame.input, child.input)) throw changed('Checkpoint direct ownership, input or contract changed');
      if (!wasHandled && child.state.kind === 'waiting' && saved.delivery && saved.delivery.status !== 'succeeded') throw changed('A failed or cancelled child cannot execute again');
      queue.push({ head: saved, handled: wasHandled });
    }
  }
  return { heads, handled };
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function changed(message: string): RuntimeError {
  return new RuntimeError('CHECKPOINT_CONTENT_CHANGED', message);
}
