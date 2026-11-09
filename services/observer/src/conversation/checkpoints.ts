import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isEqual } from 'es-toolkit';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { cloneCheckpointValue, type CheckpointStore, type CheckpointHead } from '@weiliang0121/capix-checkpoint';
import type { ModelSettings, TranscriptRangeLocator } from '@weiliang0121/capix-protocol';
import type { Transcript } from '@weiliang0121/capix-transcript';
import type { Memories } from '@weiliang0121/capix-memory';
import { validateSettings } from './model/settings.js';
import { executionProgressSchema, conversationCheckpointOutput, acceptedCheckpointInput } from './checkpoint.js';
import { memorySchema } from './group/checkpoint.js';
import { acceptConversationRequest } from './accept.js';
import { preparedConversationContextSchema } from './group/context/schema.js';
import type { ActiveViewSnapshot } from '@capix/observer-content';

/** Fixed construction basis for one R/E call; never a saved Submission or a mutable current conversation. */
export interface ConversationCheckpointRun {
  readonly conversationId: string;
  readonly rootContextId: string;
  readonly executionContextId: string;
  readonly settings: Readonly<ModelSettings>;
  readonly configuration: { readonly files: boolean; readonly fileScope?: string; readonly maxDecisionSteps: number; readonly customDecision: boolean; readonly customMaintenance: boolean };
  readonly transcript: TranscriptRangeLocator & { readonly revision: number; readonly fingerprint: string };
  readonly input: TranscriptRangeLocator;
  readonly memories: { readonly id: string; readonly sequence: number; readonly items?: ReturnType<Memories['snapshot']> };
}
export interface ConversationCheckpointRuns {
  register(run: ConversationCheckpointRun): void;
  read(conversationId: string, rootContextId: string): ConversationCheckpointRun | undefined;
  list(conversationId: string): readonly ConversationCheckpointRun[];
}

const id = z.string().min(1).max(1024);
const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const range = z.strictObject({ transcriptId: id, start: position, end: position, revision: position });
const schema = z.strictObject({
  conversationId: id,
  rootContextId: id,
  executionContextId: id,
  settings: z.unknown(),
  configuration: z.strictObject({
    files: z.boolean(),
    fileScope: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    maxDecisionSteps: z.int().min(1).max(16),
    customDecision: z.boolean(),
    customMaintenance: z.boolean().default(false),
  }),
  transcript: range.extend({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }),
  input: range,
  memories: z.strictObject({ id, sequence: position, items: z.array(memorySchema).optional() }),
});

export function copyConversationCheckpointRun(value: unknown): ConversationCheckpointRun {
  const parsed = schema.parse(cloneCheckpointValue(value));
  const settings = validateSettings(parsed.settings);
  if (!isEqual(settings, parsed.settings)) throw new Error('Checkpoint run settings contain unsupported fields');
  const { transcript, input } = parsed;
  if (transcript.start > transcript.end || input.start >= input.end || input.end !== transcript.end || input.transcriptId !== transcript.transcriptId || input.revision > transcript.revision || parsed.rootContextId === parsed.executionContextId) throw new Error('Checkpoint run ranges or identities do not match');
  return cloneCheckpointValue({ ...parsed, settings }) as unknown as ConversationCheckpointRun;
}

export class MemoryConversationCheckpointRuns implements ConversationCheckpointRuns {
  readonly #runs = new Map<string, ConversationCheckpointRun>();
  register(run: ConversationCheckpointRun): void {
    const fixed = copyConversationCheckpointRun(run);
    const previous = this.#runs.get(fixed.rootContextId);
    if (previous && !isEqual(previous, fixed)) throw new RuntimeError('CHECKPOINT_CONFLICT', 'Conversation checkpoint construction basis cannot change');
    this.#runs.set(fixed.rootContextId, fixed);
  }
  read(conversationId: string, rootContextId: string): ConversationCheckpointRun | undefined {
    const run = this.#runs.get(rootContextId);
    return run?.conversationId === conversationId ? run : undefined;
  }
  list(conversationId: string): readonly ConversationCheckpointRun[] {
    return Object.freeze([...this.#runs.values()].filter((run) => run.conversationId === conversationId));
  }
}

export function checkpointTranscriptFingerprint(transcript: Transcript, start: number, end: number): string {
  const hash = createHash('sha256');
  for (let index = start; index < end; index++) hash.update(JSON.stringify(transcript.get(index))).update('\n');
  return hash.digest('hex');
}

/** Refuse changed sources. Only this E's confirmed fixed assistant append may follow its captured input. */
export function validateConversationCheckpointContent(run: ConversationCheckpointRun, transcript: Transcript, memories: Memories, checkpoints?: CheckpointStore): void {
  validateCheckpointContent(run, transcript, memories, false, checkpoints);
}

/** Only the host's verified final E delivery can use this path; no E resources or work are reconstructed. */
export function validateConversationCheckpointDeliveryContent(run: ConversationCheckpointRun, transcript: Transcript, memories: Memories): void {
  validateCheckpointContent(run, transcript, memories, true);
}

function validateCheckpointContent(run: ConversationCheckpointRun, transcript: Transcript, memories: Memories, finalDelivery: boolean, checkpoints?: CheckpointStore): void {
  const saved = run.transcript;
  if (saved.transcriptId !== transcript.id || saved.end > transcript.length || saved.revision > transcript.revision || run.memories.id !== memories.id || checkpointTranscriptFingerprint(transcript, Math.min(saved.start, run.input.start), saved.end) !== saved.fingerprint) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '恢复依据与当前对话内容不一致。');
  if (!finalDelivery) {
    const heads = checkpoints ? checkpointSubtree(run.executionContextId, checkpoints) : new Map<string, CheckpointHead>();
    const memoryVersions = validateCheckpointMemories(run, memories, heads);
    validatePreparedMaterial(run, transcript, heads, memoryVersions);
  }
  const state = transcript.exportState();
  const receipts = (state.appends ?? []).filter((append) => append.request.operation.parentContextId === run.executionContextId && append.receipt.start >= saved.end).sort((left, right) => left.receipt.start - right.receipt.start);
  let end = saved.end;
  let revision = saved.revision;
  for (const append of receipts) {
    if (append.receipt.start !== end || append.receipt.revision !== revision + 1 || append.receipt.count !== 1 || append.request.operation.position !== 'answer' || append.request.messages.some((message) => message.role !== 'assistant')) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '恢复依据之后存在其他消息或分段变化。');
    end += append.receipt.count;
    revision = append.receipt.revision;
  }
  if (end !== transcript.length || revision !== transcript.revision) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '该调用之后已有新内容，不能继续旧调用。');
}

/** The accepted E state names a receipt; only the entity can confirm that it really committed. */
export function validateConversationCheckpointReceipt(run: ConversationCheckpointRun, transcript: Transcript, head: CheckpointHead | undefined): void {
  if (!head) return;
  if (head.delivery?.status === 'succeeded') {
    const output = conversationCheckpointOutput.decode(head.delivery.output);
    const receipts = (transcript.exportState().appends ?? []).filter((append) => append.request.operation.parentContextId === run.executionContextId && append.request.operation.position === 'answer' && append.receipt.start >= run.transcript.end);
    if (receipts.length !== 1 || receipts[0]!.receipt.count !== 1 || !isEqual(receipts[0]!.request.messages, [{ role: 'assistant', content: output.content }])) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '最终交付与已保存回答凭据不一致。');
    return;
  }
  const saved = head.image.state;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !('progress' in saved)) return;
  const progress = executionProgressSchema.parse(saved.progress);
  if (!progress.answer) return;
  const response = head.image.frame.children.find((child) => child.order === progress.responseOrder);
  if (head.image.frame.owner.contextId !== run.executionContextId || head.image.frame.owner.parentContextId !== run.rootContextId || !response || response.identity.parentContextId !== run.executionContextId || response.state.kind !== 'returned' || response.state.reception.kind !== 'accepted' || !progress.receipt) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '恢复的父子归属与对话不一致。');
  const receipt = transcript.confirmFixed({ contract: { key: 'transcript.append', version: 1 }, operation: { parentContextId: run.executionContextId, childContextId: response.identity.contextId, position: 'answer' }, transcriptId: transcript.id, messages: [{ role: 'assistant', content: progress.answer.content }] });
  if (!receipt || !isEqual(receipt, progress.receipt)) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '已接纳回答缺少一致的消息写入凭据。');
}

/** Cross-check host ownership against both kernel heads before binding current resources. */
export function validateConversationCheckpointHeads(run: ConversationCheckpointRun, root: CheckpointHead | undefined, execution: CheckpointHead | undefined, transcript: Transcript): void {
  if (root?.image.contract.key !== 'observer.conversation.scene' || root.image.contract.version !== 5 || execution?.image.contract.key !== 'observer.conversation.task' || execution.image.contract.version !== 7) throw new RuntimeError('CHECKPOINT_DECLARATION_CHANGED', '恢复所需的 R/E 声明版本不同，旧入口契约不能自动迁移。');
  const child = root?.image.frame.children[0];
  const reference = root?.image.references.execution;
  if (!root || !execution || root.image.frame.owner.contextId !== run.rootContextId || root.image.frame.owner.kind !== 'scene' || root.image.frame.owner.parentContextId !== undefined || root.image.frame.children.length !== 1 || child?.identity.contextId !== run.executionContextId || child.identity.parentContextId !== run.rootContextId || !reference || !('contextId' in reference) || reference.contextId !== run.executionContextId || execution.image.frame.owner.contextId !== run.executionContextId || execution.image.frame.owner.parentContextId !== run.rootContextId || execution.image.frame.owner.kind !== 'group') throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '恢复调用身份与对话登记不一致。');
  const input = acceptedCheckpointInput.decode(execution.image.frame.input);
  const expected = acceptConversationRequest(
    root.image.frame.input,
    (messages) => {
      if (messages.length !== run.input.end - run.input.start) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '原始请求与正式接纳的消息范围不一致。');
      return messages.map((message, offset) => {
        const index = run.input.start + offset;
        if (!isEqual(transcript.get(index), message)) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '原始请求与已保存输入正文不一致。');
        return { index, message };
      });
    },
    run.configuration.files,
  );
  if (input.messageIndex !== run.input.end - 1 || !isEqual(input, expected)) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', 'E 的输入与实际接纳位置不一致。');
}

/** Admit only fixed memory batches owned by this exact E subtree, never arbitrary later edits. */
type MemoryVersions = ReadonlyMap<number, ReturnType<Memories['snapshot']>>;

function validateCheckpointMemories(run: ConversationCheckpointRun, memories: Memories, heads: ReadonlyMap<string, CheckpointHead>): MemoryVersions {
  const versions = new Map<number, ReturnType<Memories['snapshot']>>();
  if (run.memories.items) versions.set(run.memories.sequence, run.memories.items);
  if (run.memories.sequence === memories.sequence) {
    if (run.memories.items && !isEqual(run.memories.items, memories.snapshot())) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '记忆内容与固定依据不一致。');
    versions.set(run.memories.sequence, memories.snapshot());
    return versions;
  }
  if (!heads.size || !run.memories.items) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '缺少可核对的记忆落实依据。');
  const expected = new Map(run.memories.items.map((memory) => [memory.id, memory]));
  let sequence = run.memories.sequence;
  for (const apply of memories.exportState().applies ?? []) {
    if (apply.receipt.sequence <= sequence) continue;
    const head = heads.get(apply.request.operation.contextId);
    if (apply.receipt.startSequence !== sequence || !head || head.image.contract.key !== 'observer.apply-memory' || apply.request.operation.position !== 'memories' || !isEqual((head.image.frame.input as { memories?: unknown }).memories, apply.request.changes)) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '记忆变化不属于本次恢复的已固定批次。');
    let changed = 0;
    for (const change of apply.request.changes) {
      if (change.action === 'update') {
        const previous = expected.get(change.memoryId);
        if (!previous) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '固定记忆批次的更新目标不存在。');
        if (isEqual(previous, { id: change.memoryId, ...change.result })) continue;
      }
      const id = apply.receipt.memoryIds[changed];
      if (!id || (change.action === 'create' ? expected.has(id) : id !== change.memoryId)) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '固定记忆批次的落实身份不一致。');
      expected.set(id, { id, ...change.result });
      changed++;
    }
    if (changed !== apply.receipt.memoryIds.length || changed !== apply.receipt.sequence - sequence) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '固定记忆批次的落实数量不一致。');
    sequence = apply.receipt.sequence;
    versions.set(sequence, [...expected.values()]);
  }
  if (sequence !== memories.sequence) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '当前记忆包含无法归属的后续变化。');
  if (!isEqual([...expected.values()], memories.snapshot())) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '当前记忆内容与固定批次的落实结果不一致。');
  return versions;
}

/** Traverse only declared direct relations. The same declaration may occur under different parents. */
function checkpointSubtree(contextId: string, checkpoints: CheckpointStore): ReadonlyMap<string, CheckpointHead> {
  const heads = new Map<string, CheckpointHead>();
  const pending = [contextId];
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]!;
    if (heads.has(id)) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '恢复调用关系存在重复。');
    const head = checkpoints.read(id);
    if (!head) continue;
    heads.set(id, head);
    for (const child of head.image.frame.children) {
      const saved = checkpoints.read(child.identity.contextId);
      if (saved && (saved.image.frame.owner.parentContextId !== id || !isEqual(saved.image.frame.owner, child.identity))) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '记忆调用的直接归属不一致。');
      pending.push(child.identity.contextId);
    }
  }
  return heads;
}

/** Saved material is an exact historical selection, never a fresh read of today's active index. */
function validatePreparedMaterial(run: ConversationCheckpointRun, transcript: Transcript, heads: ReadonlyMap<string, CheckpointHead>, memoryVersions: MemoryVersions): void {
  const execution = heads.get(run.executionContextId);
  const state = execution?.image.state;
  if (state && typeof state === 'object' && !Array.isArray(state) && 'prepared' in state) validate(state.prepared);
  for (const head of heads.values()) {
    if (head.image.contract?.key === 'observer.prepare-context') {
      if (head.image.point === 'completed') validate(head.image.state);
      if (head.delivery?.status === 'succeeded') validate(head.delivery.output);
    }
    for (const child of head.image.frame.children) {
      if (child.contract?.key === 'observer.prepare-context' && child.state.kind === 'returned') validate(child.state.output);
    }
  }

  function validate(value: unknown): void {
    const prepared = preparedConversationContextSchema.parse(value);
    validateMaterial(prepared.material);
    const selected = prepared.material.messages.filter((item) => item.index !== run.input.end - 1);
    if (
      !isEqual(prepared.context.message, transcript.get(run.input.end - 1)) ||
      !isEqual(prepared.context.selectedMessages, selected) ||
      !isEqual(
        prepared.selection.historyIndexes,
        selected.map((item) => item.index),
      )
    )
      throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '准备材料的输入、选择和正文不一致。');
  }

  function validateMaterial(material: ActiveViewSnapshot): void {
    const basis = material.basis;
    const version = memoryVersions.get(basis.memorySequence);
    if (basis.transcriptId !== transcript.id || basis.memoriesId !== run.memories.id || basis.transcriptRevision !== run.transcript.revision || !version) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '准备材料缺少本次调用范围内的固定来源版本。');
    for (const item of material.messages) {
      if (item.index < run.transcript.start || item.index >= run.transcript.end || !isEqual(item.message, transcript.get(item.index))) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '准备材料引用了不同范围或正文的消息。');
    }
    const memories = new Map(version.map((memory) => [memory.id, memory]));
    for (const memory of material.memories) {
      if (!isEqual(memory, memories.get(memory.id))) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '准备材料的记忆与该版本的固定落实内容不一致。');
    }
  }
}
