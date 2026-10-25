import { createCallableInvocation, restoreCallableInvocation } from '../../invocation/builders/structure.js';
import type { ChildCall, ChildCalls, ChildContract, ChildOptions, ChildReference, CallableInput, CallableOutput, CallableDelta, ResumeChildCalls } from '../../definition/children.js';
import type { OperationOptions } from '../../operation/contract.js';
import { InvocationCancelled } from '../../invocation/cancellation.js';
import type { ChildEntry } from '../../definition/entry.js';
import type { Invocation } from '../../invocation/invocation.js';
import { ChildCallFailure } from '../../invocation/provenance.js';
import type { BoundChildren } from './bound.js';
import type { InvocationChildReferences } from './references.js';
import type { ReceptionDefinition } from '../../definition/reception.js';
import type { BoundReceptions } from '../receptions.js';
import { combineOutputReceivers } from '../../output/delivery.js';

export type ChildBindingsParent = Invocation<any, any, any>;

/** Public overloads have checked result/reception association before heterogeneous dispatch. */
type InvocationChildOperationOptions<D extends ChildContract> = ChildOptions<D> & OperationOptions<CallableOutput<D>, unknown, unknown, CallableDelta<D>> & { readonly reception?: ReceptionDefinition<D, any> };

interface ChildAccessOptions {
  readonly children: BoundChildren;
  readonly names?: ReadonlyMap<string, ChildContract>;
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
      ...Object.fromEntries([...(options.names ?? [])].filter(([, definition]) => options.allowed.has(definition)).map(([name, definition]) => [name, Object.freeze({ invoke: (input: unknown, reception?: InvocationChildOperationOptions<ChildContract>) => this.invoke(definition, input, reception ?? {}) })])),
      invoke: this.invoke.bind(this),
      create: this.create.bind(this),
      entry: this.entry.bind(this),
      open: this.open.bind(this),
      facts: options.references.facts,
      ...(options.restoring ? { resume: this.resume.bind(this) } : {}),
    });
  }

  private invoke<D extends ChildContract>(definition: D, input: CallableInput<D>, options: InvocationChildOperationOptions<D> = {}): Promise<any> {
    return this.perform(() =>
      this.options.parent.children.accepting(async () => {
        this.requireAllowed(definition);
        const contract = options.reception ? this.options.receptions.require(options.reception, definition) : undefined;
        const receiver = options.result;
        if (options.delta !== undefined && typeof options.delta !== 'function') throw new TypeError('Delta receiver must be a function');
        if (receiver?.succeeded !== undefined && typeof receiver.succeeded !== 'function') throw new TypeError('Success receiver must be a function');
        if (receiver?.failed !== undefined && typeof receiver.failed !== 'function') throw new TypeError('Failure receiver must be a function');
        const succeeded = receiver?.succeeded?.bind(receiver);
        const failed = receiver?.failed?.bind(receiver);
        const delta = options.delta?.bind(options);
        const output = options.output;
        const outputReceive = output?.receive.bind(output);
        const outputFailed = output?.failed?.bind(output);
        const outputReceiver = combineOutputReceivers<CallableOutput<D>, CallableDelta<D>>(
          delta
            ? {
                receive: (event) => {
                  if (event.kind !== 'delta') return undefined;
                  const returned: unknown = delta(event.delta);
                  if (returned !== undefined) {
                    void Promise.resolve(returned).catch(() => undefined);
                    throw new TypeError('Delta receivers must return undefined synchronously');
                  }
                  return undefined;
                },
              }
            : undefined,
          outputReceive ? { receive: outputReceive, failed: outputFailed } : undefined,
        );
        const child = createCallableInvocation(this.options.children.get(definition), this.options.parent, input, {
          key: options.key,
          declarationPosition: this.options.children.position(definition),
          receiveFailure: !!failed,
          ...(outputReceiver ? { output: outputReceiver } : {}),
        });
        const relation = this.options.parent.children.get(child);
        return this.receiveTarget(relation, succeeded, failed, contract);
      }),
    );
  }

  private async receiveTarget(relation: import('../../invocation/relation.js').InvocationRelation, succeeded?: (value: any) => unknown, failed?: (failure: unknown) => unknown, contract?: import('../../invocation/reception.js').InvocationReceptionBinding): Promise<any> {
    const child = relation.invocation;
    try {
      await child.run();
    } catch (error) {
      try {
        // Test control without first owning cancellation: a completed source failure
        // and a closed receiver window are separate facts, just as for resource operations.
        this.options.parent.requireActive();
        this.checkActive();
      } catch (windowFailure) {
        const sourceFailure = relation.returned?.status === 'failed' ? relation.returned.error : error;
        if (sourceFailure === windowFailure || (sourceFailure instanceof InvocationCancelled && windowFailure instanceof InvocationCancelled)) throw windowFailure;
        throw new AggregateError([sourceFailure, windowFailure], 'Child operation failed after its reception window became unavailable', { cause: sourceFailure });
      }
      if (!failed || relation.returned?.status !== 'failed' || !relation.returned.failure?.receptionAllowed || relation.returned.error instanceof InvocationCancelled || child.context.progress.round === 0 || ['setup', 'control', 'observation'].includes(relation.returned.failure?.phase ?? 'setup')) throw error;
      return relation.handle((failure) => {
        this.checkActive();
        return failed(failure);
      }, contract);
    }
    // A reception failure is never fed back into its own failure callback.
    return relation.accept((output) => {
      this.checkActive();
      return succeeded ? succeeded(output) : output;
    }, contract);
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
      const accepted = entry.accept({ input, key: options.key, facts: { children: this.options.references.facts } });
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
      invoke: (options: Pick<InvocationChildOperationOptions<D>, 'result' | 'reception'> = {}) =>
        this.perform(() =>
          this.options.parent.children.accepting(async () => {
            if (!relation.returned) this.requireAllowed(entry.definition);
            const receiver = options.result;
            if (receiver?.succeeded !== undefined && typeof receiver.succeeded !== 'function') throw new TypeError('Success receiver must be a function');
            if (receiver?.failed !== undefined && typeof receiver.failed !== 'function') throw new TypeError('Failure receiver must be a function');
            const contract = options.reception ? this.options.receptions.require(options.reception, entry.definition as D) : undefined;
            const succeeded = receiver?.succeeded?.bind(receiver);
            const failed = receiver?.failed?.bind(receiver);
            if (failed && !relation.returned) relation.receiveFailures();
            return this.receiveTarget(relation, succeeded, failed, contract);
          }),
        ),
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
