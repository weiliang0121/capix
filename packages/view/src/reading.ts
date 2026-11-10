import type { SourceBindings, SyncSourceBindings, SourceInspection, SourceSnapshot, ViewKey, ViewSource, ViewSources } from './source.js';
import type { ViewBasis, ViewEntry, ViewIndex, ViewIndexEntry, ViewReference, ViewSnapshot, ViewState, ViewSourceChecks } from './types.js';
import { checkKey, checkStamp, conflict, data, exactKeys, object, sameIdentity, sameStamp, synchronous } from './value.js';

/** Freeze method selection for this access, without retaining endpoints in the View. */
export function sourcePorts<Sources extends ViewSources>(sources: SyncSourceBindings<Sources>, slots: readonly string[], validate?: () => void): SyncSourceBindings<Sources>;
export function sourcePorts<Sources extends ViewSources>(sources: SourceBindings<Sources>, slots: readonly string[], validate?: () => void): SourceBindings<Sources>;
export function sourcePorts<Sources extends ViewSources>(sources: SourceBindings<Sources>, slots: readonly string[], validate?: () => void): SourceBindings<Sources> {
  object(sources);
  exactKeys(sources, slots);
  const entries = slots.map((slot) => {
    const source: ViewSource<ViewKey, unknown, unknown> = sources[slot]!;
    if (!source || typeof source.index !== 'function' || typeof source.inspect !== 'function' || typeof source.read !== 'function' || typeof source.check !== 'function') throw new TypeError('Invalid view source endpoint');
    const index = source.index.bind(source);
    const inspect = source.inspect.bind(source);
    const read = source.read.bind(source);
    const check = source.check.bind(source);
    const returned = <Value>(result: Value): Value => {
      try {
        validate?.();
      } catch (error) {
        void Promise.resolve(result).catch(() => undefined);
        throw error;
      }
      return result;
    };
    return [
      slot,
      Object.freeze({
        index: () => {
          validate?.();
          return returned(index());
        },
        inspect: (keys: readonly ViewKey[]) => {
          validate?.();
          return returned(inspect(keys));
        },
        read: (keys: readonly ViewKey[], stamp: Parameters<typeof read>[1]) => {
          validate?.();
          return returned(read(keys, stamp));
        },
        check: (stamp: Parameters<typeof check>[0]) => {
          validate?.();
          return returned(check(stamp));
        },
      }),
    ];
  });
  return Object.freeze(Object.fromEntries(entries)) as SourceBindings<Sources>;
}

type Directory = SourceInspection<ViewKey, unknown>;
type Snapshot = SourceSnapshot<ViewKey, unknown>;

/** A single read session: fixed source methods, source stamps and detached data. */
export class ViewReading<Sources extends ViewSources> {
  // The public mapped contract keeps slot types; heterogeneous traversal validates keys and stamps below.
  readonly #ports: Readonly<Record<string, ViewSource<ViewKey, unknown, unknown>>>;
  readonly #slots: readonly string[];

  constructor(
    private readonly state: ViewState<Sources>,
    sources: SourceBindings<Sources>,
  ) {
    this.#slots = Object.keys(state.sources);
    this.#ports = sourcePorts<Sources>(sources, this.#slots);
  }

  async index(): Promise<ViewIndex<Sources>> {
    const directories = new Map<string, Directory>();
    for (const slot of this.#slots) {
      const keys = this.keys(slot);
      directories.set(slot, this.directory(slot, await this.#ports[slot]!.inspect(keys), keys));
    }
    const index = this.project(directories, this.state.members);
    await this.check(index.basis);
    return index;
  }

  indexSync(): ViewIndex<Sources> {
    return this.selectionSync(this.state.members);
  }

  selectionSync(members: readonly ViewReference<Sources>[], expected?: ViewBasis<Sources>): ViewIndex<Sources> {
    const directories = new Map<string, Directory>();
    for (const slot of this.#slots) {
      const keys = this.keys(slot, members);
      directories.set(slot, this.directory(slot, synchronous(this.#ports[slot]!.inspect(keys), 'Source inspection'), keys));
    }
    const index = this.project(directories, members);
    if (expected) for (const slot of this.#slots) if (!sameStamp(index.basis.sources[slot]!, expected.sources[slot]!)) conflict('View source version has changed');
    this.checkSync(index.basis);
    return index;
  }

  /** A direct inclusion establishes only its new members, not the readability of retained ones. */
  additionsSync(members: readonly ViewReference<Sources>[]): ViewSourceChecks<Sources> {
    const stamps: Record<string, Directory['stamp']> = {};
    for (const slot of new Set(members.map((member) => member.source))) {
      const keys = this.keys(slot, members);
      const inspected = this.directory(slot, synchronous(this.#ports[slot]!.inspect(keys), 'Source inspection'), keys);
      Object.defineProperty(stamps, slot, { value: inspected.stamp, enumerable: true });
    }
    for (const [slot, stamp] of Object.entries(stamps)) this.checked(synchronous(this.#ports[slot]!.check(stamp), 'Source checking'));
    return Object.freeze(stamps) as ViewSourceChecks<Sources>;
  }

  async capture(basis: ViewBasis<Sources>): Promise<ViewSnapshot<Sources>> {
    await this.check(basis);
    const snapshots = new Map<string, Snapshot>();
    for (const slot of this.#slots) {
      const keys = this.keys(slot);
      if (keys.length) snapshots.set(slot, this.snapshot(slot, await this.#ports[slot]!.read(keys, basis.sources[slot]!), basis, keys));
    }
    await this.check(basis);
    return this.values(basis, snapshots);
  }

  captureSync(basis: ViewBasis<Sources>): ViewSnapshot<Sources> {
    this.checkSync(basis);
    const snapshots = new Map<string, Snapshot>();
    for (const slot of this.#slots) {
      const keys = this.keys(slot);
      if (keys.length) snapshots.set(slot, this.snapshot(slot, synchronous(this.#ports[slot]!.read(keys, basis.sources[slot]!), 'Source reading'), basis, keys));
    }
    this.checkSync(basis);
    return this.values(basis, snapshots);
  }

  private async check(basis: ViewBasis<Sources>): Promise<void> {
    for (const slot of this.#slots) this.checked(await this.#ports[slot]!.check(basis.sources[slot]!));
  }

  private checkSync(basis: ViewBasis<Sources>): void {
    for (const slot of this.#slots) this.checked(synchronous(this.#ports[slot]!.check(basis.sources[slot]!), 'Source checking'));
  }

  private checked(result: unknown): void {
    if (typeof result !== 'boolean') throw new TypeError('Source checking must return a boolean');
    if (!result) conflict('View source version has changed');
  }

  private directory(slot: string, value: Directory, keys: readonly ViewKey[]): Directory {
    const accepted = data(value);
    object(accepted);
    exactKeys(accepted, ['stamp', 'entries']);
    checkStamp(accepted.stamp);
    if (!sameIdentity(accepted.stamp, this.state.sources[slot]!)) conflict('View source identity or scope has changed');
    const returned = this.entries(accepted.entries);
    if (returned.size !== keys.length || keys.some((key) => !returned.has(key))) throw new RangeError('Source must inspect every requested member and no others');
    for (const entry of accepted.entries) exactKeys(entry, ['key', 'summary']);
    return accepted;
  }

  private snapshot(slot: string, value: Snapshot, basis: ViewBasis<Sources>, keys: readonly ViewKey[]): Snapshot {
    const accepted = data(value);
    object(accepted);
    exactKeys(accepted, ['stamp', 'entries']);
    checkStamp(accepted.stamp);
    if (!sameStamp(accepted.stamp, basis.sources[slot]!)) conflict('Source returned content from another version');
    const returned = this.entries(accepted.entries);
    if (returned.size !== keys.length || keys.some((key) => !returned.has(key))) throw new RangeError('Source must return every requested member and no others');
    for (const entry of accepted.entries) exactKeys(entry, ['key', 'value']);
    return accepted;
  }

  private entries(entries: readonly { readonly key: ViewKey }[]): Set<ViewKey> {
    if (!Array.isArray(entries)) throw new TypeError('Source entries must be an array');
    const keys = new Set<ViewKey>();
    for (const entry of entries) {
      object(entry);
      checkKey(entry.key);
      if (keys.has(entry.key)) throw new TypeError('Source entries must be unique');
      keys.add(entry.key);
    }
    return keys;
  }

  private project(directories: ReadonlyMap<string, Directory>, members: readonly ViewReference<Sources>[]): ViewIndex<Sources> {
    const summaries = new Map(Array.from(directories, ([slot, directory]) => [slot, new Map(directory.entries.map((entry) => [entry.key, entry.summary]))]));
    const entries = members.map((member) => {
      const values = summaries.get(member.source)!;
      if (!values.has(member.key)) throw new RangeError('View member is missing or outside the source scope');
      return Object.freeze({ ...member, summary: values.get(member.key) });
    });
    const stamps = Object.freeze(Object.fromEntries(Array.from(directories, ([slot, directory]) => [slot, directory.stamp]))) as ViewBasis<Sources>['sources'];
    return Object.freeze({ basis: Object.freeze({ viewRevision: this.state.revision, sources: stamps }), members, entries: Object.freeze(entries) as readonly ViewIndexEntry<Sources>[] });
  }

  private keys(slot: string, members: readonly ViewReference<Sources>[] = this.state.members): readonly ViewKey[] {
    return Object.freeze(members.filter((member) => member.source === slot).map((member) => member.key));
  }

  private values(basis: ViewBasis<Sources>, snapshots: ReadonlyMap<string, Snapshot>): ViewSnapshot<Sources> {
    const values = new Map(Array.from(snapshots, ([slot, snapshot]) => [slot, new Map(snapshot.entries.map((entry) => [entry.key, entry.value]))]));
    const entries = this.state.members.map((member) => Object.freeze({ ...member, value: values.get(member.source)!.get(member.key) }));
    return Object.freeze({ basis, entries: Object.freeze(entries) as readonly ViewEntry<Sources>[] });
  }
}
