import type { CheckpointBinding } from '../checkpoint/work.js';
import type { InvocationIdentity } from '@capix/contracts';
import type { ChildInvocationView } from './view.js';
import type { InvocationOutputReceiver, RuntimeErrorValue } from '@capix/contracts';
import type { InvocationRelationChange } from '../observation/facts.js';
import { combineFaults } from '@capix/changes';
import type { InvocationFailure } from './failure.js';
import type { InvocationRelationView, InvocationView } from './view.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationResult } from './result.js';
import type { InvocationPropagationScope } from './provenance.js';
import type { InvocationReceptionBinding } from './reception.js';

export interface InvocationRelationOptions {
  /** Work position in a composition, not the reusable behavior's identity. */
  key?: string;
  /** Fixed declaration position in the owning parent's resolved children. */
  declarationPosition?: number;
  output?: InvocationOutputReceiver<any, any>;
  /** An explicit operation receiver owns failed delivery; raw calls keep strict propagation. */
  receiveFailure?: boolean;
}

export interface InvocationTarget<Output = unknown> {
  readonly context: InvocationContext<unknown, Output>;
  run(): Promise<Output>;
  readonly view?: InvocationView;
  readonly callView?: ChildInvocationView;
  readonly checkpointBinding?: CheckpointBinding;
  readonly identity?: InvocationIdentity;
}

export type InvocationRelationReception = Readonly<{ status: 'pending' } | ({ readonly contract?: InvocationReceptionBinding } & ({ status: 'receiving' } | { status: 'accepted' | 'handled'; output: unknown } | { status: 'failed'; error: unknown; failure?: InvocationFailure; diagnostic?: RuntimeErrorValue }))>;

/** Already-decoded relationship facts. Installing them does not replay return or acceptance. */
export interface InvocationRelationBaseline<Output = unknown> {
  readonly returned?: InvocationResult<Output>;
  readonly reception: InvocationRelationReception;
}

export interface InvocationRelationOwner {
  requireHealthy(): void;
  accepting<Value>(work: () => Promise<Value>): Promise<Value>;
  fail(failure: InvocationFailure): void;
  publish(relation: InvocationRelation, change: InvocationRelationChange): unknown | undefined;
  receive<Value>(relation: InvocationRelation, work: () => Promise<Value>): Promise<Value>;
  captureDelivery(): InvocationPropagationScope;
  receptionFailure(relation: InvocationRelation, error: unknown, scope: InvocationPropagationScope): { error: unknown; failure: InvocationFailure; delivery: unknown };
}

export interface InvocationRelationSetup<Output = unknown> {
  readonly target: InvocationTarget<Output>;
  readonly round: number;
  readonly order: number;
  readonly key?: string;
  readonly declarationPosition?: number;
  readonly receiveFailure?: boolean;
}

/** A direct parent-child relationship, not another invocation or E/O/A execution layer. */
export class InvocationRelation<Output = unknown> {
  #returned?: InvocationResult<Output>;
  #restoredReception = false;
  readonly view: InvocationRelationView;
  #reception: InvocationRelationReception = Object.freeze({ status: 'pending' });
  private target: InvocationTarget<Output>;
  readonly round: number;
  readonly order: number;
  readonly key?: string;
  readonly declarationPosition?: number;
  #receiveFailure: boolean;

  constructor(
    identity: InvocationRelationSetup<Output>,
    private readonly owner: InvocationRelationOwner,
  ) {
    this.target = identity.target;
    this.round = identity.round;
    this.order = identity.order;
    this.key = identity.key;
    this.declarationPosition = identity.declarationPosition;
    this.#receiveFailure = identity.receiveFailure ?? false;
    const relation = this;
    this.view = Object.freeze({
      get invocation() {
        if (!relation.invocation.view) throw new Error('Child invocation has no business view');
        return relation.invocation.view;
      },
      round: this.round,
      key: this.key,
      get returned() {
        return relation.returned;
      },
      get reception() {
        return relation.reception;
      },
    });
  }

  get receiveFailure(): boolean {
    return this.#receiveFailure;
  }

  /** A precise checkpoint handle may install its receiver before starting the saved child. */
  receiveFailures(): void {
    this.owner.requireHealthy();
    if (this.#returned || this.#reception.status !== 'pending') throw new Error('Failure reception must be chosen before child execution');
    this.#receiveFailure = true;
  }

  get invocation(): InvocationTarget<Output> {
    return this.target;
  }

  /** Rebuild a saved relationship without emitting new return/acceptance facts. */
  install(target: InvocationTarget<Output>, state: InvocationRelationBaseline<Output>): void {
    this.target = target;
    this.#restoredReception = state.reception.status === 'receiving';
    this.#returned = state.returned ? Object.freeze(state.returned) : undefined;
    this.#reception = Object.freeze(state.reception);
  }

  replace(target: InvocationTarget<Output>): void {
    this.target = target;
  }

  get returned(): InvocationResult<Output> | undefined {
    return this.#returned;
  }

  get reception(): InvocationRelationReception {
    return this.#reception;
  }

  returnedWith(result: InvocationResult<Output>): void {
    if (this.#returned) throw new Error('Child invocation has already returned');
    this.#returned = Object.freeze(result);
    if (result.status === 'failed' && result.failure && (!this.receiveFailure || !result.failure.receptionAllowed)) this.owner.fail(result.failure);
    this.owner.publish(this, { kind: 'returned', result: this.#returned });
  }

  accept<Value>(work: (delivered: Output) => Value | Promise<Value>, contract?: InvocationReceptionBinding): Promise<Value> {
    try {
      return this.owner.accepting(() => this.acceptResult(work, contract));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Handling a failed delivery never rewrites that child's outcome as succeeded. */
  handle<Value>(work: (failure: unknown) => Value | Promise<Value>, contract?: InvocationReceptionBinding): Promise<Value> {
    try {
      return this.owner.accepting(async () => {
        if (!this.receiveFailure || this.#returned?.status !== 'failed' || !this.#returned.failure?.receptionAllowed) throw new Error('Child has no receivable failed delivery');
        const scope = this.owner.captureDelivery();
        const failure = this.#returned.error;
        this.beginReception(contract, true);
        const output = await this.receiveWithinParent(failure, work, scope, contract);
        this.#reception = Object.freeze({ status: 'handled', output, ...(contract ? { contract } : {}) });
        const observed = this.owner.publish(this, { kind: 'handled', output });
        if (observed !== undefined) throw observed;
        return output;
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async acceptResult<Value>(work: (delivered: Output) => Value | Promise<Value>, contract?: InvocationReceptionBinding): Promise<Value> {
    const scope = this.owner.captureDelivery();
    if (this.#returned?.status !== 'succeeded') throw new Error('Child invocation has not returned successfully');
    const delivered = this.#returned.output;
    this.beginReception(contract);
    const output = await this.receiveWithinParent(delivered, work, scope, contract);
    // Acceptance is fixed before notification. A later observer failure cannot undo it.
    this.completeReception(output, contract);
    return output;
  }

  private beginReception(contract?: InvocationReceptionBinding, failed = false): void {
    this.owner.requireHealthy();
    if (!this.#returned || (failed ? this.#returned.status !== 'failed' : this.#returned.status !== 'succeeded')) throw new Error('Child invocation has not returned the expected outcome');
    if (contract && contract.childPosition !== this.declarationPosition) throw new Error('Reception contract belongs to a different child position');
    if (this.#reception.status !== 'pending' && !this.#restoredReception) throw new Error('Child result has already entered acceptance');
    if (this.#restoredReception && this.#reception.status === 'receiving' && this.#reception.contract !== contract) throw new Error('Restored reception contract cannot be replaced');
    this.#restoredReception = false;
    this.#reception = Object.freeze({ status: 'receiving', ...(contract ? { contract } : {}) });
    const observed = this.owner.publish(this, { kind: 'receiving' });
    if (observed !== undefined) {
      this.#reception = Object.freeze({ status: 'failed', error: observed, ...(contract ? { contract } : {}) });
      const failed = this.owner.publish(this, { kind: 'failed', error: observed, source: 'observation' });
      throw combineFaults([observed, ...(failed !== undefined ? [failed] : [])]);
    }
  }

  private async receiveWithinParent<Delivered, Value>(delivered: Delivered, work: (delivered: Delivered) => Value | Promise<Value>, scope: InvocationPropagationScope, contract?: InvocationReceptionBinding): Promise<Value> {
    try {
      this.owner.requireHealthy();
      return await this.owner.receive(this, async () => {
        const value = await work(delivered);
        try {
          contract?.check(value);
        } catch (cause) {
          // A contract violation is a technical failure, even if a validator throws
          // a DeclaredException. It cannot authorize another business reception.
          throw new Error('Parent reception value violates its contract', { cause });
        }
        return value;
      });
    } catch (error) {
      const rejected = this.owner.receptionFailure(this, error, scope);
      this.#reception = Object.freeze({ status: 'failed', error: rejected.error, failure: rejected.failure, ...(contract ? { contract } : {}) });
      const failed = this.owner.publish(this, { kind: 'failed', error: rejected.error, source: 'work' });
      if (failed !== undefined) throw new AggregateError([rejected.error, failed], 'Child acceptance and observation both failed', { cause: rejected.error });
      throw rejected.delivery;
    }
  }

  private completeReception(output: unknown, contract?: InvocationReceptionBinding): void {
    this.#reception = Object.freeze({ status: 'accepted', output, ...(contract ? { contract } : {}) });
    const accepted = this.owner.publish(this, { kind: 'accepted', output });
    if (accepted !== undefined) throw accepted;
  }
}
