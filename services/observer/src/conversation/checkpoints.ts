import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isEqual } from 'es-toolkit';
import { RuntimeError, cloneCheckpointValue, type CheckpointStore, type CheckpointHead } from '@capix/server-runtime';
import type { ModelSettings, TranscriptRangeLocator } from '@capix/protocol';
import type { Transcript, Memories } from '@capix/server-runtime/content';
import { validateSettings } from '../assembly/settings.js';
import { executionProgressSchema, conversationCheckpointOutput } from './checkpoint.js';
import { memorySchema } from './operations/checkpoint.js';

/** Fixed construction basis for one R/E call; never a saved Submission or a mutable current conversation. */
export interface ConversationCheckpointRun {
  readonly conversationId: string;
  readonly rootContextId: string;
  readonly executionContextId: string;
  readonly settings: Readonly<ModelSettings>;
  readonly configuration: { readonly files: boolean; readonly fileScope?: string; readonly maxDecisionSteps: number; readonly customDecision: boolean };
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
  if (!finalDelivery) validateCheckpointMemories(run, memories, checkpoints);
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
  if (head.image.frame.owner.contextId !== run.executionContextId || head.image.frame.owner.parentContextId !== run.rootContextId || !progress.responseChildId || !progress.receipt) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '恢复的父子归属与对话不一致。');
  const receipt = transcript.confirmFixed({ contract: { key: 'transcript.append', version: 1 }, operation: { parentContextId: run.executionContextId, childContextId: progress.responseChildId, position: 'answer' }, transcriptId: transcript.id, messages: [{ role: 'assistant', content: progress.answer.content }] });
  if (!receipt || !isEqual(receipt, progress.receipt)) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '已接纳回答缺少一致的消息写入凭据。');
}

/** Cross-check host ownership against both kernel heads before binding current resources. */
export function validateConversationCheckpointHeads(run: ConversationCheckpointRun, root: CheckpointHead | undefined, execution: CheckpointHead | undefined): void {
  const child = root?.image.frame.children[0];
  const state = root?.image.state;
  if (!root || !execution || root.image.frame.owner.contextId !== run.rootContextId || root.image.frame.owner.level !== 'runtime' || root.image.frame.owner.parentContextId !== undefined || root.image.frame.children.length !== 1 || child?.identity.contextId !== run.executionContextId || child.identity.parentContextId !== run.rootContextId || !state || typeof state !== 'object' || Array.isArray(state) || !('childId' in state) || state.childId !== run.executionContextId || execution.image.frame.owner.contextId !== run.executionContextId || execution.image.frame.owner.parentContextId !== run.rootContextId || execution.image.frame.owner.level !== 'execution') throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '恢复调用身份与对话登记不一致。');
}

/** Admit only fixed memory batches owned by this exact E subtree, never arbitrary later edits. */
function validateCheckpointMemories(run: ConversationCheckpointRun, memories: Memories, checkpoints?: CheckpointStore): void {
  if (run.memories.sequence === memories.sequence) {
    if (run.memories.items && !isEqual(run.memories.items, memories.snapshot())) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '记忆内容与固定依据不一致。');
    return;
  }
  if (!checkpoints || !run.memories.items) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '缺少可核对的记忆落实依据。');
  const heads = new Map<string, CheckpointHead>();
  const pending = [run.executionContextId];
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
  }
  if (sequence !== memories.sequence) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '当前记忆包含无法归属的后续变化。');
  if (!isEqual([...expected.values()], memories.snapshot())) throw new RuntimeError('CHECKPOINT_CONTENT_CHANGED', '当前记忆内容与固定批次的落实结果不一致。');
}
