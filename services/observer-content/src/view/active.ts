import { RuntimeError } from '@capix/contracts';
import { MemoryViewSource, type Memories, type MemoryState } from '@capix/memory';
import { TranscriptViewSource, type Transcript } from '@capix/transcript';
import type { Message } from '@capix/protocol';
import { View, type ViewBasis, type ViewReference, type ViewState } from '@capix/view';
import { isEqual } from 'es-toolkit';

/** Current membership belongs to the conversation's content; it has no independent identity. */
export interface ActiveViewState {
  readonly transcriptId: string;
  readonly memoriesId: string;
  readonly revision: number;
  readonly messageIndexes: readonly number[];
  readonly memoryIds: readonly string[];
}

export interface ActiveViewBasis {
  readonly transcriptId: string;
  readonly memoriesId: string;
  readonly indexRevision: number;
  readonly transcriptRevision: number;
  readonly memorySequence: number;
}

/** Actual immutable values, not handles which could later read updated memory contents. */
export interface ActiveViewSnapshot {
  readonly basis: ActiveViewBasis;
  readonly messages: readonly { readonly index: number; readonly message: Readonly<Message> }[];
  readonly memories: readonly MemoryState[];
}

export interface ActiveViewSelection {
  readonly basis: ActiveViewBasis;
  readonly messageIndexes: readonly number[];
  readonly memoryIds: readonly string[];
}

export interface ActiveViewPersistence {
  commit(change: { readonly basis: ActiveViewBasis; readonly state: ActiveViewState }): undefined;
}

type ActiveSources = { readonly messages: TranscriptViewSource; readonly memories: MemoryViewSource };

/** A narrow mutable index over existing content. Source writes and index decisions remain separate facts. */
export class ActiveView {
  readonly #view: View<ActiveSources>;
  readonly #sources: ActiveSources;
  #messageCount: number;
  #memorySequence: number;
  readonly #knownMemories: Set<string>;

  constructor(
    private readonly transcript: Transcript,
    private readonly memories: Memories,
    options: { readonly saved?: ActiveViewState; readonly persistence?: ActiveViewPersistence } = {},
  ) {
    this.persistence = options.persistence;
    const state = freezeActiveView(
      options.saved ??
        initialActiveView(
          transcript.id,
          memories.id,
          transcript.activeStart,
          transcript.length,
          memories.values().map((memory) => memory.id),
        ),
    );
    if (state.transcriptId !== transcript.id || state.memoriesId !== memories.id || memories.transcript !== transcript) throw new TypeError('Active content belongs to another content scope');
    this.checkMembers(state.messageIndexes, state.memoryIds);
    this.#sources = Object.freeze({ messages: new TranscriptViewSource(transcript), memories: new MemoryViewSource(memories) });
    this.#view = new View<ActiveSources>({
      revision: state.revision,
      sources: { messages: { id: transcript.id, scope: this.#sources.messages.scope }, memories: { id: memories.id, scope: this.#sources.memories.scope } },
      members: members(state.messageIndexes, state.memoryIds),
    });
    this.#messageCount = transcript.length;
    this.#memorySequence = memories.sequence;
    this.#knownMemories = new Set(memories.values().map((memory) => memory.id));
  }

  private readonly persistence?: ActiveViewPersistence;

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
    if (messageIndexes.length || memoryIds.length) {
      const current = activeState(this.#view.exportState());
      this.#view.applySync(this.#sources, { basis: this.viewBasis(this.basis()), members: members([...current.messageIndexes, ...messageIndexes], [...current.memoryIds, ...memoryIds]) });
    }
    this.#messageCount = this.transcript.length;
    this.#memorySequence = this.memories.sequence;
    for (const id of memoryIds) this.#knownMemories.add(id);
  }

  capture(): ActiveViewSnapshot {
    this.synchronize();
    const snapshot = this.#view.captureSync(this.#sources);
    const messages: { readonly index: number; readonly message: Readonly<Message> }[] = [];
    const memories: MemoryState[] = [];
    for (const entry of snapshot.entries) {
      if (entry.source === 'messages') messages.push(Object.freeze({ index: entry.key, message: entry.value }));
      else memories.push(entry.value);
    }
    return Object.freeze({
      basis: Object.freeze({ transcriptId: snapshot.basis.sources.messages.id, memoriesId: snapshot.basis.sources.memories.id, indexRevision: snapshot.basis.viewRevision, transcriptRevision: Number(snapshot.basis.sources.messages.version), memorySequence: Number(snapshot.basis.sources.memories.version) }),
      messages: Object.freeze(messages),
      memories: Object.freeze(memories),
    });
  }

  apply(selection: ActiveViewSelection): ActiveViewSnapshot {
    this.synchronize();
    if (!isEqual(selection.basis, this.basis())) throw new RuntimeError('ACTIVE_CONTENT_CONFLICT', '活跃材料依据已经变化，需要重新读取后再处理。');
    this.checkMembers(selection.messageIndexes, selection.memoryIds);
    const persistence = this.persistence;
    this.#view.applySync(this.#sources, { basis: this.viewBasis(selection.basis), members: members(selection.messageIndexes, selection.memoryIds) }, persistence ? { commit: ({ state }) => persistence.commit({ basis: selection.basis, state: activeState(state) }) } : undefined);
    return this.capture();
  }

  exportState(): ActiveViewState {
    this.synchronize();
    return activeState(this.#view.exportState());
  }

  private basis(): ActiveViewBasis {
    return Object.freeze({ transcriptId: this.transcript.id, memoriesId: this.memories.id, indexRevision: this.#view.exportState().revision, transcriptRevision: this.transcript.revision, memorySequence: this.memories.sequence });
  }

  private viewBasis(basis: ActiveViewBasis): ViewBasis<ActiveSources> {
    return {
      viewRevision: basis.indexRevision,
      sources: {
        messages: { id: basis.transcriptId, scope: this.#sources.messages.scope, version: String(basis.transcriptRevision) },
        memories: { id: basis.memoriesId, scope: this.#sources.memories.scope, version: String(basis.memorySequence) },
      },
    };
  }

  private checkMembers(messageIndexes: readonly number[], memoryIds: readonly string[]): void {
    if (!Array.isArray(messageIndexes) || !Array.isArray(memoryIds) || new Set(messageIndexes).size !== messageIndexes.length || new Set(memoryIds).size !== memoryIds.length) throw new TypeError('Active content requires unique member arrays');
    if (messageIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || !this.transcript.get(index))) throw new TypeError('Active message does not exist');
    if (memoryIds.some((id) => typeof id !== 'string' || !this.memories.get(id))) throw new TypeError('Active memory does not exist');
  }
}

function members(messageIndexes: readonly number[], memoryIds: readonly string[]): readonly ViewReference<ActiveSources>[] {
  return [...messageIndexes.map((key): ViewReference<ActiveSources> => ({ source: 'messages', key })), ...memoryIds.map((key): ViewReference<ActiveSources> => ({ source: 'memories', key }))];
}

function activeState(state: ViewState<ActiveSources>): ActiveViewState {
  const messageIndexes: number[] = [];
  const memoryIds: string[] = [];
  for (const member of state.members) {
    if (member.source === 'messages') messageIndexes.push(member.key);
    else memoryIds.push(member.key);
  }
  return freezeActiveView({ transcriptId: state.sources.messages.id, memoriesId: state.sources.memories.id, revision: state.revision, messageIndexes, memoryIds });
}

export function initialActiveView(transcriptId: string, memoriesId: string, start: number, end: number, memoryIds: readonly string[]): ActiveViewState {
  return freezeActiveView({ transcriptId, memoriesId, revision: 0, messageIndexes: Array.from({ length: end - start }, (_, offset) => start + offset), memoryIds });
}

/** Source append/create participates in the source's persistence transaction. Existing exclusions stay excluded. */
export function appendActiveView(state: ActiveViewState, messageIndexes: readonly number[], memoryIds: readonly string[]): ActiveViewState {
  if (!messageIndexes.length && !memoryIds.length) return state;
  return freezeActiveView({ ...state, revision: nextRevision(state.revision), messageIndexes: [...state.messageIndexes, ...messageIndexes], memoryIds: [...state.memoryIds, ...memoryIds] });
}

export function freezeActiveView(state: ActiveViewState): ActiveViewState {
  if (!state || typeof state.transcriptId !== 'string' || !state.transcriptId || typeof state.memoriesId !== 'string' || !state.memoriesId || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.messageIndexes) || !Array.isArray(state.memoryIds)) throw new TypeError('Invalid active content index');
  if (new Set(state.messageIndexes).size !== state.messageIndexes.length || state.messageIndexes.some((index) => !Number.isSafeInteger(index) || index < 0) || new Set(state.memoryIds).size !== state.memoryIds.length || state.memoryIds.some((id) => typeof id !== 'string' || !id)) throw new TypeError('Invalid active content members');
  return Object.freeze({ transcriptId: state.transcriptId, memoriesId: state.memoriesId, revision: state.revision, messageIndexes: Object.freeze([...state.messageIndexes]), memoryIds: Object.freeze([...state.memoryIds]) });
}

function nextRevision(revision: number): number {
  if (!Number.isSafeInteger(revision + 1)) throw new RangeError('Active content revision is exhausted');
  return revision + 1;
}
