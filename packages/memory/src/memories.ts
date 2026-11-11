import { randomUUID } from 'node:crypto';
import { RuntimeError, stableValue, type Stable, type InvocationOrigin } from '@weiliang0121/capix-contracts';
import { publishFact, combineFaults, type ChangeProvenance, type EventConsumer, type ChangeCapture } from '@weiliang0121/capix-changes';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import type { MemoryEvent } from './event.js';
import type { MemoryMutation } from './change.js';
import type { MemoryApplication, MemoryBasis, MemoryContent, MemoryContentContract, MemoryContentContractIdentity, MemoryItem, MemoryRead, MemorySnapshot } from './memory.js';
import type { MemoriesCommit, MemoriesPersistence, MemoriesState } from './persistence.js';
import type { MemoryFixedApply, MemoryApplyReceipt, MemoryApplyState } from './apply.js';
import { equalStable, hasOnlyKeys, isNonBlankString, isRecord, isUuid } from './validation.js';

export interface MemoriesOptions<Metadata = never> {
  readonly contentContract?: MemoryContentContract<Metadata>;
  readonly observation?: EventConsumer<MemoryEvent<Metadata>>;
  readonly changes?: ChangeCapture<MemoryEvent<Metadata>>;
  readonly persistence?: MemoriesPersistence<Metadata>;
}

export interface MemoryApplyOptions<Metadata = never> extends ChangeProvenance<MemoryEvent<Metadata>> {
  readonly expected?: MemoryBasis;
}

/** The only write owner. All material leaving this collection is an immutable value. */
export class Memories<Metadata = never> {
  #id: string = randomUUID();
  #sequence = 0;
  #mutating = false;
  #uncertain?: PersistenceError;
  readonly #items = new Map<string, Stable<MemoryItem<Metadata>>>();
  readonly #applies = new Map<string, Stable<MemoryApplyState<Metadata>>>();
  readonly #contentContract: Stable<MemoryContentContractIdentity>;
  readonly #check?: (value: Stable<MemoryContent<Metadata>>) => void;
  readonly #observation?: EventConsumer<MemoryEvent<Metadata>>;
  readonly #changes?: ChangeCapture<MemoryEvent<Metadata>>;
  readonly #persistence?: MemoriesPersistence<Metadata>;

  constructor(options: MemoriesOptions<Metadata> = {}) {
    const fields = dataOptions(options, ['contentContract', 'observation', 'changes', 'persistence']);
    const contract = fields.contentContract === undefined ? { key: 'memory.content', version: 1 } : dataOptions(fields.contentContract, ['key', 'version', 'check']);
    this.#contentContract = stableValue({ key: contract.key, version: contract.version }) as Stable<MemoryContentContractIdentity>;
    validateContract(this.#contentContract);
    if (contract.check !== undefined && typeof contract.check !== 'function') throw new TypeError('Memory content check must be a function');
    this.#check = contract.check as ((value: Stable<MemoryContent<Metadata>>) => void) | undefined;
    this.#observation = fields.observation as EventConsumer<MemoryEvent<Metadata>> | undefined;
    this.#changes = fields.changes as ChangeCapture<MemoryEvent<Metadata>> | undefined;
    this.#persistence = fields.persistence as MemoriesPersistence<Metadata> | undefined;
  }

  get id(): string {
    return this.#id;
  }

  get contentContract(): Stable<MemoryContentContractIdentity> {
    return this.#contentContract;
  }

  /** Content change count, independent of fixed no-op confirmations and observation. */
  get sequence(): number {
    this.requireCertain();
    return this.#sequence;
  }

  read(id: string): MemoryRead<Metadata> | undefined {
    this.requireCertain();
    const item = this.#items.get(id);
    return item === undefined ? undefined : (stableValue({ id: item.id, basis: this.basis(), value: item.value }) as MemoryRead<Metadata>);
  }

  /** Explicit complete enumeration; ordinary writes and single-item reads never use this path. */
  values(): Stable<readonly MemoryItem<Metadata>[]> {
    this.requireCertain();
    return stableValue([...this.#items.values()]) as Stable<readonly MemoryItem<Metadata>[]>;
  }

  snapshot(): Stable<MemorySnapshot<Metadata>> {
    this.requireCertain();
    return stableValue({ basis: this.basis(), items: this.values() }) as Stable<MemorySnapshot<Metadata>>;
  }

  exportState(): Stable<MemoriesState<Metadata>> {
    this.requireCertain();
    return stableValue({ version: 2, id: this.id, contentContract: this.contentContract, sequence: this.#sequence, items: this.values(), ...(this.#applies.size ? { applies: [...this.#applies.values()] } : {}) }) as Stable<MemoriesState<Metadata>>;
  }

  /** Hydrate current material without executing writes, persistence or publication. */
  static restore<Metadata = never>(value: MemoriesState<Metadata> | Stable<MemoriesState<Metadata>>, options: MemoriesOptions<Metadata> = {}): Memories<Metadata> {
    const restored: Memories<Metadata> = new Memories(options);
    restored.#mutating = true;
    try {
      const state: unknown = stableValue(value);
      if (!isRecord(state) || !hasOnlyKeys(state, ['version', 'id', 'contentContract', 'sequence', 'items'], ['applies']) || state.version !== 2 || !isUuid(state.id) || !Array.isArray(state.items) || !Number.isSafeInteger(state.sequence) || (state.sequence as number) < state.items.length || (state.items.length === 0 && state.sequence !== 0)) throw new TypeError('Invalid current memory state');
      validateContract(state.contentContract);
      if (!equalStable(state.contentContract, restored.contentContract)) throw new TypeError('Memory content contract does not match persisted material');
      restored.#id = state.id;
      restored.#sequence = state.sequence as number;
      for (const item of state.items) {
        if (!isRecord(item) || !hasOnlyKeys(item, ['id', 'value']) || !isUuid(item.id) || restored.#items.has(item.id)) throw new TypeError('Invalid or duplicate persisted memory identity');
        restored.validateContent(item.value);
        restored.#items.set(item.id, item as unknown as Stable<MemoryItem<Metadata>>);
      }
      const births = new Map<string, number>();
      const deadlines = new Map<string, number>();
      const reserved = new Set<number>();
      if (state.applies !== undefined) {
        if (!Array.isArray(state.applies)) throw new TypeError('Invalid persisted memory applies');
        let previousSequence = 0;
        for (const saved of state.applies) {
          if (!isRecord(saved) || !hasOnlyKeys(saved, ['request', 'receipt'])) throw new TypeError('Invalid persisted memory apply');
          const request = restored.acceptFixed(saved.request);
          const receipt = restored.acceptReceipt(saved.receipt, request, previousSequence, births, deadlines, reserved);
          const key = applyKey(request);
          if (restored.#applies.has(key)) throw new TypeError('Duplicate persisted memory apply operation');
          restored.#applies.set(key, stableValue({ request, receipt }) as Stable<MemoryApplyState<Metadata>>);
          previousSequence = receipt.sequence;
        }
      }
      restored.validateTimeline(births, deadlines, reserved);
      return restored;
    } finally {
      restored.#mutating = false;
    }
  }

  apply(changes: readonly MemoryMutation<Metadata>[] | Stable<readonly MemoryMutation<Metadata>[]>, options: MemoryApplyOptions<Metadata> = {}): Stable<MemoryApplication<Metadata>> {
    return this.protect(() => {
      this.requireCertain();
      const fields = dataOptions(options, ['expected', 'origin', 'observation']);
      const input = stableValue({ changes, ...(Object.hasOwn(fields, 'expected') ? { expected: fields.expected } : {}) });
      const accepted = this.acceptChanges(input.changes);
      if (input.expected !== undefined) this.validateBasis(input.expected);
      const provenance = this.acceptProvenance(fields);
      return this.applyPrepared(accepted, input.expected as MemoryBasis | undefined, provenance);
    });
  }

  confirmFixed(value: MemoryFixedApply<Metadata> | Stable<MemoryFixedApply<Metadata>>): Stable<MemoryApplyReceipt> | undefined {
    return this.protect(() => this.confirmAccepted(this.acceptFixed(value)));
  }

  applyFixed(value: MemoryFixedApply<Metadata> | Stable<MemoryFixedApply<Metadata>>, provenance: ChangeProvenance<MemoryEvent<Metadata>> = {}): Stable<MemoryApplyReceipt> {
    return this.protect(() => {
      const request = this.acceptFixed(value);
      const receipt = this.confirmAccepted(request);
      if (receipt !== undefined) return receipt;
      const acceptedProvenance = this.acceptProvenance(dataOptions(provenance, ['origin', 'observation']));
      this.applyPrepared(request.command.changes, request.expected, acceptedProvenance, request);
      return this.#applies.get(applyKey(request))!.receipt;
    });
  }

  private protect<Result>(operation: () => Result): Result {
    if (this.#mutating) throw new Error('Memory validation, persistence or publication cannot reenter mutation');
    this.#mutating = true;
    try {
      return operation();
    } finally {
      this.#mutating = false;
    }
  }

  private requireCertain(): void {
    if (this.#uncertain !== undefined) throw this.#uncertain;
  }

  private basis(): Stable<MemoryBasis> {
    return stableValue({ memoriesId: this.id, sequence: this.#sequence });
  }

  private validateBasis(value: unknown): asserts value is MemoryBasis {
    if (!isRecord(value) || !hasOnlyKeys(value, ['memoriesId', 'sequence']) || !isUuid(value.memoriesId) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) throw new TypeError('Invalid memory application basis');
  }

  private validateContent(value: unknown): asserts value is Stable<MemoryContent<Metadata>> {
    if (!isRecord(value) || !hasOnlyKeys(value, ['content'], ['metadata']) || !isNonBlankString(value.content)) throw new TypeError('Memory content requires a nonblank summary');
    const result: unknown = this.#check?.(value as unknown as Stable<MemoryContent<Metadata>>);
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('Memory content check must complete synchronously');
    }
  }

  private acceptChanges(value: unknown): Stable<readonly MemoryMutation<Metadata>[]> {
    if (!Array.isArray(value)) throw new TypeError('Memory mutations must be an array');
    const targets = new Set<string>();
    for (const mutation of value) {
      if (!isRecord(mutation) || (mutation.action !== 'create' && mutation.action !== 'update') || !hasOnlyKeys(mutation, mutation.action === 'create' ? ['action', 'value'] : ['action', 'memoryId', 'value'], ['reason']) || (mutation.reason !== undefined && typeof mutation.reason !== 'string')) throw new TypeError('Invalid memory mutation');
      if (mutation.action === 'update') {
        if (!isUuid(mutation.memoryId)) throw new TypeError('Memory update requires a UUID');
        if (targets.has(mutation.memoryId)) throw new TypeError('A batch cannot update the same memory twice');
        targets.add(mutation.memoryId);
      }
      this.validateContent(mutation.value);
    }
    return value as Stable<readonly MemoryMutation<Metadata>[]>;
  }

  private acceptFixed(value: unknown): Stable<MemoryFixedApply<Metadata>> {
    const request: unknown = stableValue(value);
    if (!isRecord(request) || !hasOnlyKeys(request, ['contract', 'contentContract', 'operation', 'memoriesId', 'command'], ['expected']) || !isRecord(request.contract) || !hasOnlyKeys(request.contract, ['key', 'version']) || request.contract.key !== 'memories.apply' || request.contract.version !== 2 || request.memoriesId !== this.id || !isRecord(request.operation) || !hasOnlyKeys(request.operation, ['contextId']) || !isNonBlankString(request.operation.contextId) || !isRecord(request.command) || !hasOnlyKeys(request.command, ['position', 'changes']) || !isNonBlankString(request.command.position)) throw new TypeError('Invalid current fixed memory apply request');
    validateContract(request.contentContract);
    if (!equalStable(request.contentContract, this.contentContract)) throw new TypeError('Memory content contract does not match fixed apply');
    this.acceptChanges(request.command.changes);
    if (request.expected !== undefined) this.validateBasis(request.expected);
    return request as unknown as Stable<MemoryFixedApply<Metadata>>;
  }

  private confirmAccepted(request: Stable<MemoryFixedApply<Metadata>>): Stable<MemoryApplyReceipt> | undefined {
    const saved = this.#applies.get(applyKey(request));
    if (saved !== undefined && !equalStable(saved.request, request)) throw new RuntimeError('MEMORY_APPLY_CONFLICT', 'Fixed memory apply differs from its original request');
    if (saved !== undefined) return saved.receipt;
    this.requireCertain();
    return undefined;
  }

  private acceptProvenance(fields: Record<string, unknown>): ChangeProvenance<MemoryEvent<Metadata>> {
    const origin: unknown = stableValue(fields.origin);
    if (origin !== undefined && (!isRecord(origin) || !hasOnlyKeys(origin, ['contextId']) || !isNonBlankString(origin.contextId))) throw new TypeError('Invalid memory change origin');
    return { origin: origin as InvocationOrigin | undefined, observation: fields.observation as EventConsumer<MemoryEvent<Metadata>> | undefined };
  }

  private applyPrepared(changes: Stable<readonly MemoryMutation<Metadata>[]>, expected: MemoryBasis | undefined, provenance: ChangeProvenance<MemoryEvent<Metadata>>, request?: Stable<MemoryFixedApply<Metadata>>): Stable<MemoryApplication<Metadata>> {
    this.requireCertain();
    const before = this.basis();
    if (expected !== undefined && (expected.memoriesId !== this.id || expected.sequence !== this.#sequence)) throw new RuntimeError('MEMORY_BASIS_CONFLICT', 'Memory application basis does not match the current collection');
    // Validate all targets before generating identities or preparing any effect.
    for (const mutation of changes) if (mutation.action === 'update' && !this.#items.has(mutation.memoryId)) throw new RangeError('Memory update target does not exist');
    const changed: Stable<MemoryItem<Metadata>>[] = [];
    const events: Stable<MemoryEvent<Metadata>>[] = [];
    const correspondence: { readonly commandIndex: number; readonly memoryId: string }[] = [];
    const newIds = new Set<string>();
    for (const [commandIndex, mutation] of changes.entries()) {
      const previous = mutation.action === 'update' ? this.#items.get(mutation.memoryId) : undefined;
      if (previous !== undefined && equalStable(previous.value, mutation.value)) continue;
      const sequence = this.#sequence + changed.length + 1;
      if (!Number.isSafeInteger(sequence)) throw new RangeError('Memory sequence is exhausted');
      const id = previous?.id ?? randomUUID();
      if (previous === undefined && (this.#items.has(id) || newIds.has(id))) throw new Error('Memory identity collision');
      if (previous === undefined) newIds.add(id);
      const item = stableValue({ id, value: mutation.value }) as Stable<MemoryItem<Metadata>>;
      const event = stableValue({ type: 'memory', memoriesId: this.id, sequence, occurredAt: new Date().toISOString(), ...(provenance.origin !== undefined ? { origin: provenance.origin } : {}), change: { action: mutation.action, memoryId: id, value: mutation.value, ...(Object.hasOwn(mutation, 'reason') ? { reason: mutation.reason } : {}) } }) as Stable<MemoryEvent<Metadata>>;
      changed.push(item);
      events.push(event);
      correspondence.push({ commandIndex, memoryId: id });
    }
    const sequence = this.#sequence + changed.length;
    const result = stableValue({ before, after: { memoriesId: this.id, sequence }, changed }) as Stable<MemoryApplication<Metadata>>;
    if (changed.length === 0 && request === undefined) return result;
    const fixed = request === undefined ? undefined : (stableValue({ request, receipt: { memoriesId: this.id, startSequence: this.#sequence, sequence, changes: correspondence } }) as Stable<MemoryApplyState<Metadata>>);
    // Complete wrappers are certified before persistence. No user data is inspected after it.
    const commit = stableValue({ memoriesId: this.id, contentContract: this.contentContract, expectedSequence: this.#sequence, sequence, upserts: changed, ...(fixed !== undefined ? { fixed } : {}) }) as Stable<MemoriesCommit<Metadata>>;
    this.commit(commit);
    for (const item of changed) this.#items.set(item.id, item);
    this.#sequence = sequence;
    if (fixed !== undefined) this.#applies.set(applyKey(fixed.request), fixed);
    const faults: unknown[] = [];
    for (const event of events) {
      try {
        publishFact(event as MemoryEvent<Metadata>, this.#changes, provenance.observation ?? this.#observation);
      } catch (error) {
        faults.push(error);
      }
    }
    const fault = combineFaults(faults);
    if (fault !== undefined) throw fault;
    return result;
  }

  private commit(change: Stable<MemoriesCommit<Metadata>>): void {
    try {
      const result: unknown = this.#persistence?.commit(change);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError('Memory persistence must complete synchronously and return undefined');
      }
    } catch (cause) {
      // A hostile thrown Proxy must not prevent the instance from recording uncertainty.
      let persistenceFailure = false;
      try {
        persistenceFailure = cause instanceof PersistenceError;
      } catch {
        /* Preserve the original cause without inspecting it further. */
      }
      this.#uncertain = persistenceFailure ? (cause as PersistenceError) : new PersistenceError('memories.commit', cause);
      throw this.#uncertain;
    }
  }

  private acceptReceipt(value: unknown, request: Stable<MemoryFixedApply<Metadata>>, previousSequence: number, births: Map<string, number>, deadlines: Map<string, number>, reserved: Set<number>): Stable<MemoryApplyReceipt> {
    if (!isRecord(value) || !hasOnlyKeys(value, ['memoriesId', 'startSequence', 'sequence', 'changes']) || value.memoriesId !== this.id || !Number.isSafeInteger(value.startSequence) || (value.startSequence as number) < previousSequence || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < (value.startSequence as number) || (value.sequence as number) > this.#sequence || !Array.isArray(value.changes) || value.changes.length !== (value.sequence as number) - (value.startSequence as number)) throw new TypeError('Invalid persisted memory apply receipt');
    const start = value.startSequence as number;
    if (request.expected !== undefined && (request.expected.memoriesId !== this.id || request.expected.sequence !== start)) throw new TypeError('Persisted fixed apply has an impossible basis');
    const seen = new Set<string>();
    const commands = new Set<number>();
    let previousIndex = -1;
    for (const [index, entry] of value.changes.entries()) {
      if (!isRecord(entry) || !hasOnlyKeys(entry, ['commandIndex', 'memoryId']) || !Number.isSafeInteger(entry.commandIndex) || (entry.commandIndex as number) <= previousIndex || (entry.commandIndex as number) >= request.command.changes.length || !isUuid(entry.memoryId) || seen.has(entry.memoryId) || !this.#items.has(entry.memoryId)) throw new TypeError('Invalid persisted memory apply correspondence');
      const commandIndex = entry.commandIndex as number;
      const mutation = request.command.changes[commandIndex]!;
      if (mutation.action === 'update' && mutation.memoryId !== entry.memoryId) throw new TypeError('Persisted update receipt identifies another memory');
      const sequence = start + index + 1;
      if (mutation.action === 'create') {
        if (births.has(entry.memoryId)) throw new TypeError('A memory cannot be created by multiple fixed applies');
        births.set(entry.memoryId, sequence);
      }
      reserved.add(sequence);
      seen.add(entry.memoryId);
      commands.add(commandIndex);
      previousIndex = commandIndex;
    }
    for (const [index, mutation] of request.command.changes.entries()) {
      if (mutation.action === 'create') {
        if (!commands.has(index)) throw new TypeError('Persisted create has no corresponding memory');
      } else {
        if (!this.#items.has(mutation.memoryId)) throw new TypeError('Persisted update target does not exist');
        deadlines.set(mutation.memoryId, Math.min(deadlines.get(mutation.memoryId) ?? start, start));
      }
    }
    return value as unknown as Stable<MemoryApplyReceipt>;
  }

  /** Check that recorded creation positions and updates can fit the preserved item order. */
  private validateTimeline(births: ReadonlyMap<string, number>, deadlines: ReadonlyMap<string, number>, reserved: ReadonlySet<number>): void {
    let previousBirth = 0;
    for (const id of this.#items.keys()) {
      const known = births.get(id);
      let birth = known ?? previousBirth + 1;
      if (known === undefined)
        for (; reserved.has(birth); birth++) {
          /* Fixed changes cannot create this item. */
        }
      if (birth <= previousBirth || birth > this.#sequence || (previousBirth === 0 && birth !== 1) || birth > (deadlines.get(id) ?? this.#sequence)) throw new TypeError('Persisted memory apply history is impossible');
      previousBirth = birth;
    }
  }
}

function validateContract(value: unknown): asserts value is MemoryContentContractIdentity {
  if (!isRecord(value) || !hasOnlyKeys(value, ['key', 'version']) || !isNonBlankString(value.key) || !Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new TypeError('Invalid memory content contract');
}

/** Capability options are not Stable data; reject accessors without invoking them. */
function dataOptions(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError('Memory options require an ordinary data record');
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid memory options');
    fields[key] = descriptor.value;
  }
  return fields;
}

function applyKey(request: Stable<MemoryFixedApply<unknown>>): string {
  return JSON.stringify([request.operation.contextId, request.command.position]);
}
