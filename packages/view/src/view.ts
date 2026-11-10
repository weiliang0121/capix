import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import type { SourceBindings, SyncSourceBindings, ViewSources } from './source.js';
import type { ViewBasis, ViewIndex, ViewPersistence, ViewReference, ViewSelection, ViewSnapshot, ViewState, ViewSourceChecks } from './types.js';
import { basis as acceptBasis, members as acceptMembers, memberIndex, sameMembers, state as acceptState } from './membership.js';
import { ViewReading } from './reading.js';
import { conflict, data, exactKeys, object, synchronous } from './value.js';

/** An ordered selection over named sources. The host supplies endpoints for each access. */
export class View<Sources extends ViewSources> {
  #state: ViewState<Sources>;
  #members: ReadonlyMap<string, ReadonlySet<string | number>>;
  #mutating = false;

  constructor(state: ViewState<Sources>) {
    this.#state = acceptState(state);
    this.#members = memberIndex(this.#state.members);
  }

  exportState(): ViewState<Sources> {
    return this.#state;
  }

  /** Membership is local state, not a promise that the source is still readable. */
  has(reference: ViewReference<Sources>): boolean {
    const [member] = acceptMembers<Sources>([reference], Object.keys(this.#state.sources));
    return this.#members.get(member!.source)?.has(member!.key) ?? false;
  }

  members(): readonly ViewReference<Sources>[] {
    return this.#state.members;
  }

  /** Add only new references, preserving both retained order and first requested order. */
  includeSync(sources: SyncSourceBindings<Sources>, references: readonly ViewReference<Sources>[], persistence?: ViewPersistence<Sources>): ViewState<Sources> {
    this.beginMutation();
    try {
      const previous = this.#state;
      const requested = acceptMembers(references, Object.keys(previous.sources), true);
      const added = requested.filter((member) => !this.#members.get(member.source)?.has(member.key));
      if (!added.length) return previous;
      const checkedSources = new ViewReading<Sources>(previous, sources).additionsSync(added);
      const members = Object.freeze([...previous.members, ...added]);
      return this.install(previous, members, checkedSources, persistence);
    } finally {
      this.#mutating = false;
    }
  }

  /** Removal must remain possible when the referenced source is unavailable or deleted. */
  excludeSync(references: readonly ViewReference<Sources>[], persistence?: ViewPersistence<Sources>): ViewState<Sources> {
    this.beginMutation();
    try {
      const previous = this.#state;
      const requested = acceptMembers(references, Object.keys(previous.sources), true);
      if (!requested.some((member) => this.#members.get(member.source)?.has(member.key))) return previous;
      const removed = memberIndex(requested);
      const members = Object.freeze(previous.members.filter((member) => !removed.get(member.source)?.has(member.key)));
      return this.install(previous, members, Object.freeze({}), persistence);
    } finally {
      this.#mutating = false;
    }
  }

  async index(sources: SourceBindings<Sources>): Promise<ViewIndex<Sources>> {
    const state = this.#state;
    const index = await new ViewReading<Sources>(state, sources).index();
    this.current(state);
    return index;
  }

  indexSync(sources: SyncSourceBindings<Sources>): ViewIndex<Sources> {
    const state = this.#state;
    const index = new ViewReading<Sources>(state, sources).indexSync();
    this.current(state);
    return index;
  }

  async capture(sources: SourceBindings<Sources>, index?: ViewIndex<Sources>): Promise<ViewSnapshot<Sources>> {
    const state = this.#state;
    const reading = new ViewReading<Sources>(state, sources);
    const basis = index === undefined ? (await reading.index()).basis : this.indexBasis(index, state);
    this.current(state);
    const snapshot = await reading.capture(basis);
    this.current(state);
    return snapshot;
  }

  captureSync(sources: SyncSourceBindings<Sources>, index?: ViewIndex<Sources>): ViewSnapshot<Sources> {
    const state = this.#state;
    const reading = new ViewReading<Sources>(state, sources);
    const basis = index === undefined ? reading.indexSync().basis : this.indexBasis(index, state);
    this.current(state);
    const snapshot = reading.captureSync(basis);
    this.current(state);
    return snapshot;
  }

  /** Validate, synchronously persist, then install. Cross-source transactions belong to the host. */
  applySync(sources: SyncSourceBindings<Sources>, selection: ViewSelection<Sources>, persistence?: ViewPersistence<Sources>): ViewState<Sources> {
    this.beginMutation();
    try {
      const previous = this.#state;
      const accepted = data(selection);
      object(accepted);
      exactKeys(accepted, ['basis', 'members']);
      const basis = acceptBasis(accepted.basis, previous);
      const members = acceptMembers(accepted.members, Object.keys(previous.sources));
      new ViewReading<Sources>(previous, sources).selectionSync(members, basis);
      return this.install(previous, members, basis.sources, persistence);
    } finally {
      this.#mutating = false;
    }
  }

  private beginMutation(): void {
    if (this.#mutating) conflict('A view mutation is already in progress');
    this.#mutating = true;
  }

  private install(previous: ViewState<Sources>, members: readonly ViewReference<Sources>[], checkedSources: ViewSourceChecks<Sources>, persistence?: ViewPersistence<Sources>): ViewState<Sources> {
    this.current(previous);
    if (sameMembers(previous.members, members)) return previous;
    if (!Number.isSafeInteger(previous.revision + 1)) throw new RangeError('View revision is exhausted');
    const state = Object.freeze({ revision: previous.revision + 1, sources: previous.sources, members });
    const lookup = memberIndex(members);
    if (persistence) {
      // Only the actual persistence port and its return contract carry this classification.
      // Membership/source rejection before this boundary remains an operation outcome.
      try {
        const returned = synchronous(persistence.commit(Object.freeze({ checkedSources, previous, state })), 'View persistence');
        if (returned !== undefined) throw new TypeError('View persistence must return undefined');
      } catch (cause) {
        if (cause instanceof PersistenceError) throw cause;
        throw new PersistenceError('view.commit', cause);
      }
    }
    this.#state = state;
    this.#members = lookup;
    return state;
  }

  private current(state: ViewState<Sources>): void {
    if (this.#state !== state) conflict('View membership changed during access');
  }

  private indexBasis(value: ViewIndex<Sources>, state: ViewState<Sources>): ViewBasis<Sources> {
    const index = data(value);
    object(index);
    exactKeys(index, ['basis', 'members', 'entries']);
    const basis = acceptBasis(index.basis, state);
    const members = acceptMembers(index.members, Object.keys(state.sources));
    if (!sameMembers(members, state.members)) conflict('Directory members do not match the current view');
    if (!Array.isArray(index.entries) || !sameMembers(index.entries, state.members)) throw new TypeError('Directory entries do not match its members');
    for (const entry of index.entries) exactKeys(entry, ['source', 'key', 'summary']);
    return basis;
  }
}
