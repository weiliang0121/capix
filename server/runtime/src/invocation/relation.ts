import type { CheckpointBinding } from '../checkpoint/work.js';
import type { InvocationIdentity } from './identity.js';
import type { ChildInvocationView } from './view.js';
import type { InvocationOutputReceiver } from '../output/contract.js';
import type { InvocationRelationChange } from '../observation/facts.js';
import { combineFaults } from '../observation/error.js';
import type { InvocationFailure } from './failure.js';
import type { InvocationRelationView, InvocationView } from './view.js';
import type { InvocationContext } from '../context/context.js';
import type { InvocationResult } from './result.js';
import type { InvocationPropagationScope } from './provenance.js';
import type { RuntimeErrorValue } from '@capix/protocol';

export interface InvocationRelationOptions {
  /** Work position in a composition, not the reusable behavior's identity. */
  key?: string;
  /** Fixed declaration position in the owning parent's resolved children. */
  declarationPosition?: number;
  output?: InvocationOutputReceiver<any, any>;
}

export interface InvocationTarget<Output = unknown> {
  readonly context: InvocationContext<unknown, Output>;
  run(): Promise<Output>;
  readonly view?: InvocationView;
  readonly callView?: ChildInvocationView;
  readonly checkpointBinding?: CheckpointBinding;
  readonly identity?: InvocationIdentity;
}

export type InvocationRelationReception = Readonly<{ status: 'pending' } | { status: 'receiving' } | { status: 'accepted'; output: unknown } | { status: 'failed'; error: unknown; failure?: InvocationFailure; diagnostic?: RuntimeErrorValue }>;

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

  constructor(
    identity: InvocationRelationSetup<Output>,
    private readonly owner: InvocationRelationOwner,
  ) {
    this.target = identity.target;
    this.round = identity.round;
    this.order = identity.order;
    this.key = identity.key;
    this.declarationPosition = identity.declarationPosition;
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
    if (result.status === 'failed' && result.failure) this.owner.fail(result.failure);
    this.owner.publish(this, { kind: 'returned', result: this.#returned });
  }

  accept<Value>(work: (delivered: Output) => Value | Promise<Value>): Promise<Value> {
    try {
      return this.owner.accepting(() => this.acceptResult(work));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async acceptResult<Value>(work: (delivered: Output) => Value | Promise<Value>): Promise<Value> {
    const scope = this.owner.captureDelivery();
    const delivered = this.beginReception();
    const output = await this.receiveWithinParent(delivered, work, scope);
    // Acceptance is fixed before notification. A later observer failure cannot undo it.
    this.completeReception(output);
    return output;
  }

  private beginReception(): Output {
    this.owner.requireHealthy();
    if (this.#returned?.status !== 'succeeded') throw new Error('Child invocation has not returned successfully');
    if (this.#reception.status !== 'pending' && !this.#restoredReception) throw new Error('Child result has already entered acceptance');
    this.#restoredReception = false;
    this.#reception = Object.freeze({ status: 'receiving' });
    const observed = this.owner.publish(this, { kind: 'receiving' });
    if (observed !== undefined) {
      this.#reception = Object.freeze({ status: 'failed', error: observed });
      const failed = this.owner.publish(this, { kind: 'failed', error: observed, source: 'observation' });
      throw combineFaults([observed, ...(failed !== undefined ? [failed] : [])]);
    }
    return this.#returned.output;
  }

  private async receiveWithinParent<Value>(delivered: Output, work: (delivered: Output) => Value | Promise<Value>, scope: InvocationPropagationScope): Promise<Value> {
    try {
      this.owner.requireHealthy();
      return await this.owner.receive(this, async () => work(delivered));
    } catch (error) {
      const rejected = this.owner.receptionFailure(this, error, scope);
      this.#reception = Object.freeze({ status: 'failed', error: rejected.error, failure: rejected.failure });
      const failed = this.owner.publish(this, { kind: 'failed', error: rejected.error, source: 'work' });
      if (failed !== undefined) throw new AggregateError([rejected.error, failed], 'Child acceptance and observation both failed', { cause: rejected.error });
      throw rejected.delivery;
    }
  }

  private completeReception(output: unknown): void {
    this.#reception = Object.freeze({ status: 'accepted', output });
    const accepted = this.owner.publish(this, { kind: 'accepted', output });
    if (accepted !== undefined) throw accepted;
  }
}
