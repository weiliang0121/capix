import { ResourceAccess, ResourceAccessClosed, captureResourceOwner, ResourceRequest, ResourceSupply, checkResourceRequests, resourceRequests, type ResourceOwner, type ResourceRequirements, type ResourceRefinement, type ResourceSupplyEntry } from '@weiliang0121/capix-resources';
import type { OperationOutcome } from '@weiliang0121/capix-contracts';

/** Invocation progress belongs to runtime; the resource package sees only fixed window guards. */
export interface InvocationResourceOwner extends ResourceOwner {
  readonly round?: () => number;
}

/** Coordinates one invocation's phase windows over already captured subtree supplies. */
export class InvocationResources<Resources extends object = object> {
  readonly supply: ResourceSupply;
  readonly values: Readonly<Resources>;
  readonly #requirements: ResourceRequirements;
  readonly #initial: ResourceRequirements;
  readonly #windows = new Map<string, ResourceAccess>();
  readonly #phaseRequirements = new Map<string, ResourceRequirements>();
  readonly #closed = new Set<string>();
  readonly #bound = new Set<ResourceSupplyEntry>();
  readonly #available = new Set<ResourceSupplyEntry>();
  #owner?: InvocationResourceOwner;
  #restriction?: () => void;
  #started = false;
  #phase = 'run';
  #ended = false;

  constructor(deps: ResourceRequirements<Resources>, entries: readonly ResourceSupplyEntry[] = [], initial: ResourceRequirements = deps, supply: ResourceRequirements = deps) {
    this.supply = new ResourceSupply(entries).select(supply);
    this.#requirements = Object.freeze({ ...deps });
    this.#initial = Object.freeze({ ...initial });
    this.#phaseRequirements.set('run', this.#initial);
    this.values = this.view(initial as ResourceRequirements<Resources>);
  }

  /** Named views contain only this declaration's dependencies, not the subtree's supply. */
  view<Values extends object>(deps: ResourceRequirements<Values>, phase = 'run'): Readonly<Values> {
    const fixed = Object.freeze({ ...deps });
    checkResourceRequests(this.#requirements, resourceRequests(fixed));
    this.supply.select(fixed);
    let round = this.#owner ? this.round() : undefined;
    return this.namedView(fixed, phase, () => (round ??= this.round()));
  }

  private namedView<Values extends object>(deps: ResourceRequirements<Values>, phase: string, round: () => number): Readonly<Values> {
    const values = {};
    let endpoints: Readonly<Values> | undefined;
    for (const name of Object.keys(deps)) {
      Object.defineProperty(values, name, {
        enumerable: true,
        get: () => {
          const access = this.window(phase, round(), deps);
          return (endpoints ??= access.view(deps))[name as keyof Values];
        },
      });
    }
    return Object.freeze(values) as Readonly<Values>;
  }

  restrict(validate: () => void): void {
    if (this.#restriction || this.#owner || this.#started || this.#windows.size || this.#ended) throw new Error('Resource access is already established');
    this.#restriction = validate;
  }

  attach(owner: InvocationResourceOwner): void {
    if (this.#owner || this.#started || this.#windows.size || this.#ended) throw new Error('Resource access is already established');
    const fixed = captureResourceOwner(owner);
    if (!fixed) throw new TypeError('Invocation resource owner is required');
    this.#owner = Object.freeze({ ...fixed, round: owner.round?.bind(owner) });
  }

  start(phase = 'run'): void {
    if (this.#started || this.#ended) throw new Error('Resource access has already started');
    this.#started = true;
    this.activate(phase, this.#initial);
  }

  activate(phase: string, deps: ResourceRequirements): void {
    if (!this.#started) throw new Error('Resource access requires a started invocation');
    if (this.#ended) throw new ResourceAccessClosed();
    checkResourceRequests(this.#requirements, resourceRequests(deps));
    if (this.#phase !== phase) this.close(this.#phase);
    this.#phase = phase;
    this.#phaseRequirements.set(phase, Object.freeze({ ...deps }));
    this.window(phase, this.round(), deps).view(deps);
  }

  close(phase: string): void {
    const key = `${phase}:${this.round()}`;
    this.#closed.add(key);
    this.#windows.get(key)?.close();
  }

  closeAll(): void {
    const result = this.closeAllResult();
    if (result.status === 'failed') throw result.failure;
  }

  /** Exhaust owned windows synchronously; a failed window never prevents the remaining closes. */
  closeAllResult(): OperationOutcome<void> {
    this.#ended = true;
    const failures: unknown[] = [];
    for (const window of this.#windows.values()) {
      try {
        window.close();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (!failures.length) return { status: 'succeeded', value: undefined };
    return { status: 'failed', failure: failures.length === 1 ? failures[0] : new AggregateError(failures, 'Invocation resource windows failed to close', { cause: failures[0] }) };
  }

  select<Values extends object, Input = unknown>(deps: ResourceRequirements<Values>, initial: ResourceRequirements = deps, selection?: { readonly input: Input; readonly refinements: readonly ResourceRefinement<Input>[]; readonly supply?: ResourceRequirements }): InvocationResources<Values> {
    let supply = this.supply.select(selection?.supply ?? deps);
    if (selection?.refinements.length) supply = supply.refine(selection.input, selection.refinements);
    return new InvocationResources(deps, supply.entries, initial, selection?.supply);
  }

  supplement(others: readonly InvocationResources[]): InvocationResources {
    const entries = [...this.supply.entries];
    for (const other of others) {
      for (const entry of other.supply.entries) {
        const previous = entries.find((candidate) => candidate.offer === entry.offer);
        if (previous && previous !== entry) throw new Error(`Ambiguous resource supply: ${entry.offer.name}`);
        if (!previous) entries.push(entry);
      }
    }
    const requests = Object.fromEntries(entries.map((entry, index) => [String(index), new ResourceRequest(entry.offer)]));
    return new InvocationResources(requests, entries);
  }

  provides(request: ResourceRequest<unknown>): boolean {
    return this.supply.entries.some((entry) => entry.offer === request.offer);
  }

  private round(): number {
    return Math.max(1, this.#owner?.round?.() ?? 1);
  }

  private window(phase: string, round: number, deps: ResourceRequirements): ResourceAccess {
    const key = `${phase}:${round}`;
    this.validateWindow(phase, round, key);
    const existing = this.#windows.get(key);
    if (existing) return existing;
    const access = new ResourceAccess(this.#phaseRequirements.get(phase) ?? deps, this.supply, this.#owner, {
      validate: () => this.validateWindow(phase, round, key),
      bound: (entry) => this.first(this.#bound, entry),
      available: (entry) => this.first(this.#available, entry),
    });
    this.#windows.set(key, access);
    try {
      access.start();
      return access;
    } catch (error) {
      access.close();
      this.#closed.add(key);
      throw error;
    }
  }

  private validateWindow(phase: string, round: number, key: string): void {
    try {
      if (this.#ended || this.#closed.has(key)) throw new ResourceAccessClosed();
      if (this.#owner && !this.#started) throw new Error('Resource access requires a started invocation');
      if (phase !== this.#phase) throw new ResourceAccessClosed('Resource access belongs to an inactive declaration phase');
      if (round !== this.round()) throw new ResourceAccessClosed('Resource access belongs to an inactive declaration round');
      this.#restriction?.();
    } catch (error) {
      this.#owner?.error?.(error);
      throw error;
    }
  }

  private first(entries: Set<ResourceSupplyEntry>, entry: ResourceSupplyEntry): boolean {
    if (entries.has(entry)) return false;
    entries.add(entry);
    return true;
  }
}
