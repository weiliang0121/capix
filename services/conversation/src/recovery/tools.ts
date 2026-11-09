import { isDeepStrictEqual as equal } from 'node:util';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import type { CheckpointChild, CheckpointHead } from '@weiliang0121/capix-checkpoint';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { feedbackDigest, requireExchangeIntakeReceipt, requireExchangeFeedbackReceipt, type ModelExchanges, type ModelExchangeEntry } from '@weiliang0121/capix-model-exchanges';
import { requireModelReply, modelReplyText, type ModelReply, type ModelRequest, type ModelRequestInspection } from '@weiliang0121/capix-model-provider';
import { z } from 'zod';
import type { ConversationMaterialInput } from '../materials/input.js';
import type { ConversationViewSource } from '../materials/view.js';
import type { ConversationAnswer, ConversationMaintenance, ConversationPreparation } from '../scene.js';
import { resolveConversationOutputBudget, type ConversationOutputBudget } from '../model/budget.js';
import { CompletionInteraction } from '../model/completion-contract.js';
import type { ConversationExchanges } from '../persistence/exchanges.js';
import { archiveBasis, planSchema, selectionSchema } from '../hosting/tool-answer.js';
import type { ToolExchangeUse } from '../hosting/tool-exchanges.js';
import { readToolCheckpoint } from '../hosting/tool-checkpoint.js';
import { ToolLoop, toolLoopInputCodec } from '../tools/loop.js';
import { toolAnswerRequest } from '../tools/answer.js';
import { buildToolModelRequest, toolModelInputCodec } from '../tools/model.js';
import { assertToolFeedbackBytes, assertToolOutputBytes, assertToolReplyBytes } from '../tools/budget.js';
import { assertCompletionRecovery, assertConversationContentRecovery, assertConversationInputRecovery, requireConversationRecoveryRoot, requireConversationRecoveryState, recoverySubtree, type RecoveryStore } from './basis.js';
import { createContentRecoveryScene } from './scene.js';
import { materialInputSchema, referenceSchema } from './model-codecs.js';

export const toolConversationCheckpointContract = Object.freeze({ key: 'conversation.tools.scene', version: 1 });

/** Tool execution has its own root contract; formal message/maintenance semantics remain shared. */
export function createRecoverableToolConversationScene(answer: ConversationAnswer<ConversationMaterialInput>, prepare: ConversationPreparation<ConversationMaterialInput>, maintain: ConversationMaintenance, loop: ToolLoop, outputBudget: ConversationOutputBudget) {
  if (!loop.recoverable) throw new TypeError('Tool conversation recovery requires a recoverable loop');
  return createContentRecoveryScene(answer, prepare, maintain, outputBudget, { ...toolConversationCheckpointContract, policy: toolPolicy(loop) });
}

export interface ToolConversationRecoveryStore extends RecoveryStore {
  readonly exchanges: Pick<ConversationExchanges, 'load'>;
}
export interface ToolConversationRecoveryOptions {
  readonly loop: ToolLoop;
  readonly outputBudget?: Partial<ConversationOutputBudget>;
  readonly exchangeUse: ToolExchangeUse;
  readonly inspectRequest?: (request: ModelRequest) => ModelRequestInspection;
}
type CandidateOptions = Pick<ToolConversationRecoveryOptions, 'loop' | 'outputBudget'>;

/** A candidate is explicitly unchecked: listing never loads an exchange collection or interaction. */
export function listToolConversationRecoveries(content: ConversationViewSource, store: RecoveryStore, configuration: string, options: CandidateOptions) {
  store.assertAvailable();
  return store.checkpoints
    .listRoots()
    .filter((head) => head.image.contract.key === toolConversationCheckpointContract.key && !head.delivery)
    .map((head) => {
      const contextId = head.image.frame.owner.contextId;
      try {
        requireConversationRecoveryRoot(head, toolConversationCheckpointContract);
        const state = requireConversationRecoveryState(head, configuration, options.outputBudget ?? {});
        requireToolPolicy(head, options.loop);
        assertConversationInputRecovery(content, head, state);
        return { contextId, point: head.image.point, available: false as const, eligibility: 'unchecked' as const, reason: 'Tool recovery evidence will be checked when continuation is explicitly requested' };
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        return { contextId, point: head.image.point, available: false as const, reason: error instanceof Error ? error.message : 'Tool recovery evidence is unavailable' };
      }
    });
}

/** Read exact saved facts without dispatch or writes. The caller owns and finally closes exchangeUse. */
export function assertToolConversationRecovery(content: ConversationViewSource, store: ToolConversationRecoveryStore, configuration: string, contextId: string, options: ToolConversationRecoveryOptions) {
  store.assertAvailable();
  const root = requireConversationRecoveryRoot(store.checkpoints.read(contextId), toolConversationCheckpointContract);
  const state = requireConversationRecoveryState(root, configuration, options.outputBudget ?? {});
  requireToolPolicy(root, options.loop);
  const { heads, handled } = recoverySubtree(root, { read: (id) => readToolCheckpoint(store.checkpoints, id) });
  assertCompletionRecovery(heads, handled, store.interactions);
  const contentResult = assertConversationContentRecovery(content, root, state, heads);
  const prepared = certifyPreparation(root, state, heads);
  const answerRelation = root.image.frame.children.find((child) => child.key === 'answer');
  if (!answerRelation) return contentResult;
  const answer = heads.get(answerRelation.identity.contextId);
  if (!answer || answer.image.contract.key !== 'conversation.tools.archived-answer' || answer.image.contract.version !== 1) throw changed('Tool answer has no compatible saved allocation checkpoint');
  const input = materialInputSchema.parse(answer.image.frame.input);
  if (!equal(input, prepared) || !equal(input, answerRelation.input) || input.query.transcriptId !== state.basis.accepted.transcriptId || input.query.index !== state.basis.accepted.index || input.query.content !== state.basis.accepted.message.content) throw changed('Tool answer changed its original formal query');
  const maxTokens = resolveConversationOutputBudget(options.outputBudget).answer;
  if (answer.image.point === 'prepared') {
    const plan = planSchema.parse(answer.image.state);
    if (answer.delivery || answer.image.frame.round !== 1 || answer.image.frame.nextChildOrder !== 0 || answer.image.frame.children.length || plan.empty.id !== plan.selection.collection || !equal(plan.metadata, { ...archiveBasis(options.loop, input, maxTokens), scope: plan.selection.scope })) throw changed('Prepared tool allocation differs from its exact empty intent');
    const saved = store.exchanges.load(plan.selection.collection);
    if (saved && (!equal(saved.metadata, plan.metadata) || !equal(saved.state, plan.empty))) throw changed('Prepared tool allocation cannot replace an existing nonempty or incompatible archive');
    return contentResult;
  }
  if (answer.image.point !== 'waiting' && answer.image.point !== 'completed') throw changed('Unknown tool answer recovery point');
  const selection = selectionSchema.parse(answer.image.point === 'completed' ? z.object({ selection: selectionSchema }).parse(answer.image.state).selection : answer.image.state);
  try {
    options.exchangeUse.acquireExisting(selection, { ...archiveBasis(options.loop, input, maxTokens), scope: selection.scope });
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw changed('Original tool archive is missing or incompatible; it cannot be recreated');
  }
  const exchanges = options.exchangeUse.requireLoaded(selection);
  const loopRelation = answer.image.frame.children[0];
  if (answer.image.frame.children.length !== 1 || !loopRelation || loopRelation.order !== 0 || loopRelation.target.position !== 0 || loopRelation.contract?.key !== 'conversation.tools.loop' || loopRelation.contract.version !== 2) throw changed('Tool answer lost its exact loop relation');
  const loopHead = heads.get(loopRelation.identity.contextId);
  if (!loopHead) throw changed('The original tool loop has no saved checkpoint; it cannot be dispatched again');
  const loopInput = options.loop.checkInput(toolLoopInputCodec.decode(loopHead.image.frame.input));
  if (!equal(loopInput, options.loop.input(toolAnswerRequest(input, maxTokens), selection.scope, selection.collection)) || !equal(loopRelation.input, loopHead.image.frame.input)) throw changed('Saved tool loop input differs from its original materials or archive');
  const final = certifyLoop(loopHead, heads, exchanges, store, options);
  if (answer.image.point === 'completed' && (final === undefined || z.object({ value: z.string() }).parse(answer.image.state).value !== final)) throw changed('Completed tool answer differs from its original final model reply');
  if (final !== undefined && answerRelation.state.kind === 'returned' && answerRelation.state.output !== final) throw changed('Returned tool answer differs from its original final model reply');
  return contentResult;
}

/** Reconstruct the default preparation from the root's original facts, not current content. */
function certifyPreparation(root: CheckpointHead, state: ReturnType<typeof requireConversationRecoveryState>, heads: ReadonlyMap<string, CheckpointHead>): ConversationMaterialInput | undefined {
  const relation = root.image.frame.children.find((child) => child.key === 'prepare');
  if (!relation) return undefined;
  const head = heads.get(relation.identity.contextId);
  const { basis } = state;
  if (!head || head.image.contract.key !== 'conversation.tools.prepare' || head.image.contract.version !== 1 || head.image.point !== 'captured' || !equal(head.image.frame.input, basis.accepted)) throw changed('Tool preparation has no compatible original capture');
  const memories = new Map(basis.memories.items.map((value) => [value.id, value]));
  const wasIncluded = basis.view.members.some((item) => item.source === 'messages' && item.key === basis.accepted.index);
  const expected = materialInputSchema.parse({
    query: { transcriptId: basis.accepted.transcriptId, index: basis.accepted.index, content: basis.accepted.message.content },
    materials: {
      basis: { viewRevision: basis.view.revision + (wasIncluded ? 0 : 1), sources: { messages: { ...basis.view.sources.messages, version: String(basis.transcript.revision) }, memories: { ...basis.view.sources.memories, version: String(basis.memories.sequence) } } },
      entries: basis.view.members.filter((item) => item.source === 'memories').map((item) => ({ source: 'memories', key: item.key, value: memories.get(String(item.key)) })),
    },
  });
  if (!equal(head.image.state, expected) || (head.delivery?.status === 'succeeded' && !equal(head.delivery.output, expected)) || (relation.state.kind === 'returned' && !equal(relation.state.output, expected))) throw changed('Prepared tool material differs from the original active memory view');
  return expected;
}

function certifyLoop(head: CheckpointHead, heads: ReadonlyMap<string, CheckpointHead>, exchanges: ModelExchanges, store: ToolConversationRecoveryStore, options: ToolConversationRecoveryOptions): string | undefined {
  const loop = options.loop;
  const input = loop.checkInput(toolLoopInputCodec.decode(head.image.frame.input));
  const children = head.image.frame.children;
  const models = children.filter((child) => child.target.position === 0).sort((a, b) => a.order - b.order);
  const entries = exchanges.values();
  if (!models.length || models.length > loop.maxModelCalls || entries.length > models.length || entries.some((entry) => entry.scope !== input.scope)) throw changed('Tool archive does not belong to the saved loop prefix');
  const replies = new Map<string, ModelReply>();
  for (const [index, child] of models.entries()) {
    if (child.contract?.key !== 'conversation.tools.completion' || child.contract.version !== 3) throw changed('Tool model child has an incompatible checkpoint contract');
    const savedHead = heads.get(child.identity.contextId);
    if (!savedHead) throw changed('The original model child has no saved checkpoint; it cannot be sent again');
    const next = toolModelInputCodec.decode(child.input);
    const prefix = entries.slice(0, index).map((entry) => exchanges.reference(entry));
    if (prefix.length !== index || !equal(next.exchanges, prefix)) throw changed('Tool model input changed its exact exchange prefix');
    const reference = referenceSchema.parse(savedHead.image.point === 'completed' ? z.object({ reference: referenceSchema }).parse(savedHead.image.state).reference : savedHead.image.point === 'established' ? savedHead.image.state : null);
    const request = buildToolModelRequest({ input, catalog: loop.catalog, exchanges, ...(options.inspectRequest ? { inspection: { inspectRequest: options.inspectRequest } } : {}) }, next);
    const saved = store.interactions.read(reference.id);
    if (!saved || saved.id !== reference.id || saved.contract !== CompletionInteraction.key || reference.contract !== saved.contract || !saved.feedback || !equal(saved.request, request)) throw changed('Original tool model request or durable feedback is missing; it will not be sent again');
    const reply = assertToolReplyBytes(requireModelReply(saved.feedback.payload), loop.budgets);
    if (savedHead.image.point === 'completed' && !equal(z.object({ reply: z.unknown() }).parse(savedHead.image.state).reply, reply)) throw changed('Completed model checkpoint differs from its durable feedback');
    if (child.state.kind === 'returned' && !equal(child.state.output, reply)) throw changed('Model child return differs from its durable feedback');
    if (savedHead.delivery?.status === 'succeeded' && !equal(savedHead.delivery.output, reply)) throw changed('Model child delivery differs from its durable feedback');
    replies.set(child.identity.contextId, reply);
    if (index < entries.length) certifyEntry(entries[index]!, child, children, replies, exchanges, loop, models[index + 1]?.order ?? Infinity);
    else if (child.state.kind === 'returned' && child.state.reception.kind === 'accepted') throw changed('Accepted model result has no exact archive effect');
  }
  if (head.image.point === 'completed' || head.delivery?.status === 'succeeded') {
    const reply = replies.get(models.at(-1)!.identity.contextId);
    if (!reply || reply.termination.kind !== 'completed' || reply.termination.reason !== 'stop') throw changed('Completed tool loop lacks a final model reply');
    const value = modelReplyText(reply);
    if (!value.trim() || (head.delivery?.status === 'succeeded' && head.delivery.output !== value)) throw changed('Tool loop delivery differs from its final model reply');
    return value;
  }
}

function certifyEntry(entry: ModelExchangeEntry, model: CheckpointChild, children: readonly CheckpointChild[], replies: ReadonlyMap<string, ModelReply>, exchanges: ModelExchanges, loop: ToolLoop, endOrder: number): void {
  const owner = model.identity.parentContextId;
  if (!equal(entry.operation, { parentContextId: owner, childContextId: model.identity.contextId, position: 'model-reply' }) || !equal(entry.reply, replies.get(model.identity.contextId))) throw changed('Exchange intake differs from its actual model child');
  if (model.state.kind === 'returned' && model.state.reception.kind === 'accepted') {
    const receipt = requireExchangeIntakeReceipt(model.state.reception.output);
    if (receipt.reference.collection !== exchanges.id || receipt.reference.id !== entry.id || receipt.reference.revision > entry.revision || model.state.reception.contract?.position !== 0 || !equal(receipt.operation, entry.operation)) throw changed('Model acceptance receipt differs from its fixed archive effect');
  }
  for (const feedback of entry.feedback) {
    assertToolFeedbackBytes(feedback.toolCallId, { status: feedback.status, content: feedback.content }, loop.budgets);
    const call = entry.reply.output.find((item) => item.kind === 'tool-call' && item.id === feedback.toolCallId);
    if (!call || call.kind !== 'tool-call') throw changed('Tool feedback has no original model call');
    const selected = loop.checkToolCall(call);
    const effect = entry.receptions.find((item) => item.callId === call.id);
    if (selected.kind === 'rejected') {
      if (effect || !equal(feedback, { toolCallId: call.id, ...selected.result })) throw changed('Precheck feedback differs from the fixed tool policy');
      continue;
    }
    const child = children.find((child) => child.order > model.order && child.order < endOrder && child.key === call.id && child.target.position === selected.entry.position);
    const definition = selected.entry.registration.node.checkpoint;
    if (!child || !definition || !equal(child.contract, { key: definition.key, version: definition.version }) || !equal(definition.input.decode(child.input), selected.input) || !effect || !equal(effect.operation, { parentContextId: owner, childContextId: child.identity.contextId, position: 'tool-feedback' })) throw changed('Tool feedback has no exact registered child and reception effect');
    if (child.state.kind === 'returned' && selected.entry.registration.maxOutputBytes !== undefined) assertToolOutputBytes(definition.output.decode(child.state.output), selected.entry.registration.maxOutputBytes);
    const reception = child.state.kind === 'returned' && child.state.reception.kind === 'accepted' ? child.state.reception : child.state.kind === 'failed' && child.state.reception?.kind === 'handled' ? child.state.reception : undefined;
    if (reception) {
      const receipt = requireExchangeFeedbackReceipt(reception.output);
      if (receipt.reference.collection !== exchanges.id || receipt.reference.id !== entry.id || receipt.reference.revision > entry.revision || reception.contract?.position !== selected.entry.position || receipt.feedbackDigest !== feedbackDigest(feedback) || !equal(receipt.operation, effect.operation)) throw changed('Tool acceptance differs from its fixed feedback');
    }
  }
  // A saved accepted/handled child cannot lose its feedback even when the parent point is older.
  for (const child of children.filter((child) => child.order > model.order && child.order < endOrder && child.target.position !== 0)) {
    const reception = child.state.kind === 'returned' && child.state.reception.kind === 'accepted' ? child.state.reception : child.state.kind === 'failed' && child.state.reception?.kind === 'handled' ? child.state.reception : undefined;
    if (reception && !entry.feedback.some((item) => item.toolCallId === child.key)) throw changed('Accepted tool feedback is missing from its original archive');
  }
}

function toolPolicy(loop: ToolLoop) {
  return { catalog: loop.catalog.digest, maxModelCalls: loop.maxModelCalls, waitMs: loop.waitMs, budgets: { ...loop.budgets } };
}
function requireToolPolicy(root: CheckpointHead, loop: ToolLoop): void {
  if (!loop.recoverable || !equal(z.object({ policy: z.unknown() }).parse(root.image.state).policy, toolPolicy(loop))) throw changed('Tool conversation catalog, policy or budgets changed');
}
function changed(message: string): RuntimeError {
  return new RuntimeError('CHECKPOINT_CONTENT_CHANGED', message);
}
