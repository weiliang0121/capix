import { RuntimeError } from '@weiliang0121/capix-contracts';
import { MemoryViewSource, type Memories, type MemoryState } from '@weiliang0121/capix-memory';
import { TranscriptViewSource, type Transcript } from '@weiliang0121/capix-transcript';
import type { Message } from '@weiliang0121/capix-protocol';
import { View, type ViewBasis, type ViewReference, type ViewState } from '@weiliang0121/capix-view';
import { isEqual } from 'es-toolkit';
import { appendActiveView, initialActiveView } from './default-policy.js';
import { freezeActiveView, type ActiveViewState, type ActiveViewBasis, type ActiveViewSnapshot, type ActiveViewSelection, type ActiveViewPersistence } from './state.js';

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
      const next = appendActiveView(current, messageIndexes, memoryIds);
      this.#view.applySync(this.#sources, { basis: this.viewBasis(this.basis()), members: members(next.messageIndexes, next.memoryIds) });
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
