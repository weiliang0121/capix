import { createCallableInvocation, restoreCallableInvocation } from '../../invocation/builders/structure.js';
import type { ChildCall, ChildCalls, ChildContract, ChildOptions, ChildReference, CallableInput, CallableOutput, ResumeChildCalls } from '../../definition/children.js';
import type { ChildEntry } from '../../definition/entry.js';
import type { Invocation } from '../../invocation/invocation.js';
import { ChildCallFailure } from '../../invocation/provenance.js';
import type { BoundChildren } from './bound.js';
import type { InvocationChildReferences } from './references.js';
import type { ReceptionDefinition } from '../../definition/reception.js';
import type { BoundReceptions } from '../receptions.js';

export type ChildBindingsParent = Invocation<any, any, any>;

interface ChildAccessOptions {
  readonly children: BoundChildren;
  readonly receptions: BoundReceptions;
  readonly parent: ChildBindingsParent;
  readonly allowed: ReadonlySet<ChildContract>;
  readonly validate: () => void;
  readonly references: InvocationChildReferences;
  readonly restoring: boolean;
}

/** Phase-bound actions over this parent's authenticated, phase-independent references. */
export class InvocationChildBindings {
  readonly port: ChildCalls | ResumeChildCalls;

  constructor(private readonly options: ChildAccessOptions) {
    this.port = Object.freeze({
      create: this.create.bind(this),
      entry: this.entry.bind(this),
      open: this.open.bind(this),
      facts: options.references.facts,
      ...(options.restoring ? { resume: this.resume.bind(this) } : {}),
    });
  }

  private create<D extends ChildContract>(definition: D, input: CallableInput<D>, options: ChildOptions<D> = {}): ChildCall<D> {
    return this.guard(() => {
      this.requireAllowed(definition);
      const child = createCallableInvocation(this.options.children.get(definition), this.options.parent, input, { ...options, declarationPosition: this.options.children.position(definition) });
      return this.handle(this.options.references.forTarget(definition, child));
    });
  }

  private entry<D extends ChildContract, Input>(entry: ChildEntry<D, Input>, input: Input, options: ChildOptions<D> = {}): ChildCall<D> {
    return this.guard(() => {
      const definition = entry.definition;
      this.requireAllowed(definition);
      const parent = this.options.parent;
      const accepted = entry.accept({ input, key: options.key, facts: { round: parent.context.progress.round as 1 | 2, continuation: this.options.references.continuation(parent.context.continuation), children: this.options.references.facts } });
      return this.create(definition, accepted, options);
    });
  }

  private open<D extends ChildContract>(ref: ChildReference<D>): ChildCall<D> {
    return this.guard(() => this.handle(ref));
  }

  private resume<D extends ChildContract>(ref: ChildReference<D>): ChildCall<D> {
    return this.guard(() => {
      if (!this.options.restoring) throw new Error('Child resume is available only in a checkpoint resume phase');
      const entry = this.options.references.require(ref);
      this.requireAllowed(entry.definition);
      const position = this.options.children.position(entry.definition);
      const contextId = entry.relation.invocation.context.id;
      this.options.parent.restoreChild(position, contextId, () => restoreCallableInvocation(this.options.children.get(entry.definition), this.options.parent, contextId, { declarationPosition: position }));
      return this.handle(ref);
    });
  }

  private handle<D extends ChildContract>(ref: ChildReference<D>): ChildCall<D> {
    const entry = this.options.references.require(ref);
    const relation = entry.relation;
    const access = this;
    function accept(): Promise<CallableOutput<D>>;
    function accept<Value>(receive: (output: CallableOutput<D>) => Value | Promise<Value>): Promise<Value>;
    function accept<Value>(contract: ReceptionDefinition<D, Value>, receive: (output: CallableOutput<D>) => NoInfer<Value> | Promise<NoInfer<Value>>): Promise<Value>;
    function accept<Value = CallableOutput<D>>(first?: ReceptionDefinition<D, Value> | ((output: CallableOutput<D>) => Value | Promise<Value>), receive?: (output: CallableOutput<D>) => Value | Promise<Value>): Promise<Value> {
      return access.perform(() => {
        if (first !== undefined && typeof first !== 'function' && (typeof first !== 'object' || first === null)) throw new Error('Invalid child reception contract or callback');
        const contract = typeof first === 'object' && first !== null ? access.options.receptions.require(first, entry.definition as D) : undefined;
        const callback = typeof first === 'function' ? first : receive;
        if (contract && typeof callback !== 'function') throw new Error('Typed reception requires a callback');
        return relation.accept((output) => {
          access.checkActive();
          return callback ? callback(output as CallableOutput<D>) : (output as Value);
        }, contract);
      });
    }
    return Object.freeze({
      ref,
      ...(relation.key !== undefined ? { key: relation.key } : {}),
      run: () =>
        this.perform(async () => {
          // Reading a saved delivery starts no new work. Every real start still requires uses.
          if (!relation.returned) this.requireAllowed(entry.definition);
          return (await relation.invocation.run()) as CallableOutput<D>;
        }),
      accept,
    });
  }

  private requireAllowed(definition: ChildContract): void {
    if (!this.options.allowed.has(definition)) throw new Error('Child definition is not declared in this phase uses');
  }

  private checkActive(): void {
    this.options.parent.requireHealthy();
    this.options.validate();
    this.options.parent.context.requireActive();
  }

  private guard<T>(action: () => T): T {
    try {
      this.checkActive();
      return action();
    } catch (error) {
      this.options.parent.reject(error);
      throw error;
    }
  }

  private perform<T>(action: () => T | Promise<T>): Promise<T> {
    const delivery = this.deliver(action);
    // Owned activities are joined by the parent even when the author does not await
    // this handle. Observe rejection without replacing the promise's failed result.
    void delivery.catch(() => {});
    return delivery;
  }

  private async deliver<T>(action: () => T | Promise<T>): Promise<T> {
    try {
      this.checkActive();
      return await action();
    } catch (error) {
      // A child failure is authenticated when business propagates it into a parent
      // phase, not merely because delivery arrives after that phase has advanced.
      if (!(error instanceof ChildCallFailure)) this.options.parent.reject(error);
      throw error;
    }
  }
}
