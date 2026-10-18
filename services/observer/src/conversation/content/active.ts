import { RuntimeError } from '@capix/server-runtime';
import type { Memories, MemoryState, Transcript } from '@capix/server-runtime/content';
import type { Message } from '@capix/protocol';
import { isEqual } from 'es-toolkit';

/** Current membership belongs to the conversation's content; it has no independent identity. */
export interface ActiveContentState {
  readonly transcriptId: string;
  readonly memoriesId: string;
  readonly revision: number;
  readonly messageIndexes: readonly number[];
  readonly memoryIds: readonly string[];
}

export interface ActiveContentBasis {
  readonly transcriptId: string;
  readonly memoriesId: string;
  readonly indexRevision: number;
  readonly transcriptRevision: number;
  readonly memorySequence: number;
}

/** Actual immutable values, not handles which could later read updated memory contents. */
export interface ActiveContentSnapshot {
  readonly basis: ActiveContentBasis;
  readonly messages: readonly { readonly index: number; readonly message: Readonly<Message> }[];
  readonly memories: readonly MemoryState[];
}

export interface ActiveContentSelection {
  readonly basis: ActiveContentBasis;
  readonly messageIndexes: readonly number[];
  readonly memoryIds: readonly string[];
}

export interface ActiveContentPersistence {
  commit(change: { readonly basis: ActiveContentBasis; readonly state: ActiveContentState }): undefined;
}

/** A narrow mutable index over existing content. Source writes and index decisions remain separate facts. */
export class ActiveContent {
  #state: ActiveContentState;
  #messageCount: number;
  #memorySequence: number;
  readonly #knownMemories: Set<string>;

  constructor(
    private readonly transcript: Transcript,
    private readonly memories: Memories,
    options: { readonly saved?: ActiveContentState; readonly persistence?: ActiveContentPersistence } = {},
  ) {
    this.persistence = options.persistence;
    this.#state = freezeActiveContent(
      options.saved ??
        initialActiveContent(
          transcript.id,
          memories.id,
          transcript.activeStart,
          transcript.length,
          memories.values().map((memory) => memory.id),
        ),
    );
    if (this.#state.transcriptId !== transcript.id || this.#state.memoriesId !== memories.id || memories.transcript !== transcript) throw new TypeError('Active content belongs to another content scope');
    this.checkMembers(this.#state.messageIndexes, this.#state.memoryIds);
    this.#messageCount = transcript.length;
    this.#memorySequence = memories.sequence;
    this.#knownMemories = new Set(memories.values().map((memory) => memory.id));
  }

  private readonly persistence?: ActiveContentPersistence;

  /** Required source capture calls this after the whole source mutation is installed. No observer is involved. */
  synchronize(): void {
    if (this.#messageCount === this.transcript.length && this.#memorySequence === this.memories.sequence) return;
    const messageIndexes = Array.from({ length: this.transcript.length - this.#messageCount }, (_, offset) => this.#messageCount + offset);
    const memoryIds =
      this.#memorySequence === this.memories.sequence
        ? []
        : this.memories
            .values()
            .map((memory) => memory.id)
            .filter((id) => !this.#knownMemories.has(id));
    this.#state = appendActiveContent(this.#state, messageIndexes, memoryIds);
    this.#messageCount = this.transcript.length;
    this.#memorySequence = this.memories.sequence;
    for (const id of memoryIds) this.#knownMemories.add(id);
  }

  capture(): ActiveContentSnapshot {
    this.synchronize();
    return Object.freeze({
      basis: this.basis(),
      messages: Object.freeze(
        this.#state.messageIndexes.map((index) => {
          const message = this.transcript.get(index);
          if (!message) throw new Error('Active message no longer exists');
          return Object.freeze({ index, message });
        }),
      ),
      memories: Object.freeze(
        this.#state.memoryIds.map((id) => {
          const memory = this.memories.get(id);
          if (!memory) throw new Error('Active memory no longer exists');
          return Object.freeze(memory.toJSON());
        }),
      ),
    });
  }

  apply(selection: ActiveContentSelection): ActiveContentSnapshot {
    this.synchronize();
    if (!isEqual(selection.basis, this.basis())) throw new RuntimeError('ACTIVE_CONTENT_CONFLICT', '活跃材料依据已经变化，需要重新读取后再处理。');
    this.checkMembers(selection.messageIndexes, selection.memoryIds);
    if (isEqual(selection.messageIndexes, this.#state.messageIndexes) && isEqual(selection.memoryIds, this.#state.memoryIds)) return this.capture();
    const state = freezeActiveContent({ transcriptId: this.transcript.id, memoriesId: this.memories.id, revision: nextRevision(this.#state.revision), messageIndexes: selection.messageIndexes, memoryIds: selection.memoryIds });
    const result: unknown = this.persistence?.commit({ basis: selection.basis, state });
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('Active content persistence must complete synchronously');
    }
    this.#state = state;
    return this.capture();
  }

  exportState(): ActiveContentState {
    this.synchronize();
    return this.#state;
  }

  private basis(): ActiveContentBasis {
    return Object.freeze({ transcriptId: this.transcript.id, memoriesId: this.memories.id, indexRevision: this.#state.revision, transcriptRevision: this.transcript.revision, memorySequence: this.memories.sequence });
  }

  private checkMembers(messageIndexes: readonly number[], memoryIds: readonly string[]): void {
    if (!Array.isArray(messageIndexes) || !Array.isArray(memoryIds) || new Set(messageIndexes).size !== messageIndexes.length || new Set(memoryIds).size !== memoryIds.length) throw new TypeError('Active content requires unique member arrays');
    if (messageIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || !this.transcript.get(index))) throw new TypeError('Active message does not exist');
    if (memoryIds.some((id) => typeof id !== 'string' || !this.memories.get(id))) throw new TypeError('Active memory does not exist');
  }
}

export function initialActiveContent(transcriptId: string, memoriesId: string, start: number, end: number, memoryIds: readonly string[]): ActiveContentState {
  return freezeActiveContent({ transcriptId, memoriesId, revision: 0, messageIndexes: Array.from({ length: end - start }, (_, offset) => start + offset), memoryIds });
}

/** Source append/create participates in the source's persistence transaction. Existing exclusions stay excluded. */
export function appendActiveContent(state: ActiveContentState, messageIndexes: readonly number[], memoryIds: readonly string[]): ActiveContentState {
  if (!messageIndexes.length && !memoryIds.length) return state;
  return freezeActiveContent({ ...state, revision: nextRevision(state.revision), messageIndexes: [...state.messageIndexes, ...messageIndexes], memoryIds: [...state.memoryIds, ...memoryIds] });
}

export function freezeActiveContent(state: ActiveContentState): ActiveContentState {
  if (!state || typeof state.transcriptId !== 'string' || !state.transcriptId || typeof state.memoriesId !== 'string' || !state.memoriesId || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.messageIndexes) || !Array.isArray(state.memoryIds)) throw new TypeError('Invalid active content index');
  if (new Set(state.messageIndexes).size !== state.messageIndexes.length || state.messageIndexes.some((index) => !Number.isSafeInteger(index) || index < 0) || new Set(state.memoryIds).size !== state.memoryIds.length || state.memoryIds.some((id) => typeof id !== 'string' || !id)) throw new TypeError('Invalid active content members');
  return Object.freeze({ transcriptId: state.transcriptId, memoriesId: state.memoriesId, revision: state.revision, messageIndexes: Object.freeze([...state.messageIndexes]), memoryIds: Object.freeze([...state.memoryIds]) });
}

function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision + 1)) throw new RangeError('Active content revision is exhausted');
  return revision + 1;
}
