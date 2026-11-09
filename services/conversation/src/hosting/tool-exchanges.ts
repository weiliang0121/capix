import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ModelExchanges, type ModelExchangesState } from '@weiliang0121/capix-model-exchanges';
import type { ConversationExchanges, ExchangeArchiveMetadata } from '../persistence/exchanges.js';

export interface ToolExchangeSelection {
  readonly collection: string;
  readonly scope: string;
}
export interface ToolExchangePlan {
  readonly selection: ToolExchangeSelection;
  readonly empty: ModelExchangesState;
  readonly metadata: ExchangeArchiveMetadata;
}
interface Loaded {
  readonly entity: ModelExchanges;
  readonly metadata: ExchangeArchiveMetadata;
  readonly users: Set<ToolExchangeUse>;
}

/** Host-owned cache. Entity facts stay in the archive; use handles own only memory references. */
export class ToolExchanges {
  readonly #loaded = new Map<string, Loaded>();

  constructor(private readonly archive: ConversationExchanges) {}

  openUse(): ToolExchangeUse {
    return new ToolExchangeUse(this);
  }

  get loadedCount(): number {
    return this.#loaded.size;
  }

  /** Persist the exact allocation intent. Existing nonempty archives are never recreated. */
  initialize(plan: ToolExchangePlan, use: ToolExchangeUse): ModelExchanges {
    checkPlan(plan);
    this.archive.initialize(plan.empty, plan.metadata);
    return this.acquire(plan.selection, plan.metadata, use);
  }

  acquire(selection: ToolExchangeSelection, expected: ExchangeArchiveMetadata, use: ToolExchangeUse): ModelExchanges {
    if (use.closed) throw new Error('Tool exchange use is closed');
    if (selection.scope !== expected.scope) throw new Error('Tool exchange scope differs from its archive ownership');
    let loaded = this.#loaded.get(selection.collection);
    if (!loaded) {
      const saved = this.archive.load(selection.collection);
      if (use.closed) throw new Error('Tool exchange use closed during archive loading');
      if (!saved || saved.state.id !== selection.collection || !saved.metadata || !isDeepStrictEqual(saved.metadata, expected)) throw new Error('Original tool exchange archive is missing or incompatible');
      // Loading may re-enter through a host adapter. Keep the already installed instance.
      loaded = this.#loaded.get(selection.collection);
      if (!loaded) {
        loaded = { entity: ModelExchanges.restore(saved.state, { persistence: this.archive, limits: expected.limits }), metadata: saved.metadata, users: new Set() };
        this.#loaded.set(selection.collection, loaded);
      }
    }
    if (!isDeepStrictEqual(loaded.metadata, expected)) throw new Error('Loaded tool exchange archive has different ownership');
    loaded.users.add(use);
    return loaded.entity;
  }

  release(id: string, use: ToolExchangeUse): void {
    const loaded = this.#loaded.get(id);
    if (!loaded) return;
    loaded.users.delete(use);
    if (!loaded.users.size) this.#loaded.delete(id);
  }
}

/** A single host entry attempt, including rejected admission and explicit recovery checks. */
export class ToolExchangeUse {
  #closed = false;
  readonly #held = new Map<string, { entity: ModelExchanges; scope: string }>();

  constructor(private readonly owner: ToolExchanges) {}

  get closed(): boolean {
    return this.#closed;
  }

  plan(metadata: Omit<ExchangeArchiveMetadata, 'scope'>): ToolExchangePlan {
    this.requireOpen();
    const entity = new ModelExchanges({ limits: metadata.limits });
    const scope = randomUUID();
    const fixed = structuredClone({ ...metadata, scope });
    const plan = { selection: { collection: entity.id, scope }, empty: entity.snapshot(), metadata: fixed };
    checkPlan(plan);
    this.requireOpen();
    return freeze(plan);
  }

  initializePrepared(plan: ToolExchangePlan): void {
    this.requireOpen();
    const entity = this.owner.initialize(plan, this);
    this.#held.set(entity.id, { entity, scope: plan.selection.scope });
  }

  acquireExisting(selection: ToolExchangeSelection, metadata: ExchangeArchiveMetadata): void {
    this.requireOpen();
    const entity = this.owner.acquire(selection, metadata, this);
    this.#held.set(entity.id, { entity, scope: selection.scope });
  }

  requireLoaded(selection: ToolExchangeSelection): ModelExchanges {
    this.requireOpen();
    const loaded = this.#held.get(selection.collection);
    if (!loaded || loaded.scope !== selection.scope) throw new Error('This entry has not acquired the selected tool exchange archive');
    return loaded.entity;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of this.#held.keys()) this.owner.release(id, this);
    this.#held.clear();
  }

  private requireOpen(): void {
    if (this.#closed) throw new Error('Tool exchange use is closed');
  }
}

function checkPlan(plan: ToolExchangePlan): void {
  if (!plan || !plan.metadata || plan.selection?.scope !== plan.metadata.scope || plan.selection?.collection !== plan.empty?.id || plan.empty.sequence !== 0 || !Array.isArray(plan.empty.entries) || plan.empty.entries.length !== 0) throw new TypeError('Tool allocation requires an exact empty exchange snapshot');
  ModelExchanges.restore(plan.empty, { limits: plan.metadata.limits });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
