import type { SourceBindings, SyncSourceBindings, ViewSources } from './source.js';
import type { ViewBasis, ViewIndex, ViewPersistence, ViewSelection, ViewSnapshot, ViewState } from './types.js';
import { basis as acceptBasis, members as acceptMembers, sameMembers, state as acceptState } from './membership.js';
import { ViewReading } from './reading.js';
import { conflict, data, exactKeys, object, synchronous } from './value.js';

/** An ordered selection over named sources. The host supplies endpoints for each access. */
export class View<Sources extends ViewSources> {
  #state: ViewState<Sources>;
  #applying = false;

  constructor(state: ViewState<Sources>) {
    this.#state = acceptState(state);
  }

  exportState(): ViewState<Sources> {
    return this.#state;
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
    if (this.#applying) conflict('A view selection is already being applied');
    this.#applying = true;
    try {
      const previous = this.#state;
      const accepted = data(selection);
      object(accepted);
      exactKeys(accepted, ['basis', 'members']);
      const basis = acceptBasis(accepted.basis, previous);
      const members = acceptMembers(accepted.members, Object.keys(previous.sources));
      new ViewReading<Sources>(previous, sources).selectionSync(members, basis);
      this.current(previous);
      if (sameMembers(previous.members, members)) return previous;
      if (!Number.isSafeInteger(previous.revision + 1)) throw new RangeError('View revision is exhausted');
      const state = Object.freeze({ revision: previous.revision + 1, sources: previous.sources, members });
      if (persistence) {
        const returned = synchronous(persistence.commit(Object.freeze({ basis, previous, state })), 'View persistence');
        if (returned !== undefined) throw new TypeError('View persistence must return undefined');
      }
      this.#state = state;
      return state;
    } finally {
      this.#applying = false;
    }
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
