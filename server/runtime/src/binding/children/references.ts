import type { ChildContract, ChildReference, ChildFact, ChildFacts } from '../../definition/children.js';
import type { ExceptionOrigin, ContinuationFact } from '../../definition/work.js';
import type { Invocation } from '../../invocation/invocation.js';
import type { InvocationRelation, InvocationTarget } from '../../invocation/relation.js';
import type { InvocationExceptionOrigin } from '../../invocation/provenance.js';
import type { InvocationContinuationFact } from '../../invocation/continuation.js';
import type { CheckpointReference } from '../../checkpoint/contract.js';
import { failureFact } from '../../invocation/failure.js';
import { RuntimeErrorHelper } from '../../errors/helper.js';
import { isInvocationCancelled } from '../../invocation/cancellation.js';
import type { BoundChildren } from './bound.js';
import type { BoundReceptions } from '../receptions.js';
import type { ReceptionDefinition } from '../../definition/reception.js';

interface ReferenceEntry {
  readonly definition: ChildContract;
  readonly relation: InvocationRelation;
  readonly ref: ChildReference;
}

/** One parent's authentic references outlive phase handles, never the activity itself. */
export class InvocationChildReferences {
  readonly #entries = new WeakMap<ChildReference, ReferenceEntry>();
  readonly #relations = new Map<InvocationRelation, ReferenceEntry>();
  readonly facts: ChildFacts;

  constructor(
    private readonly parent: Invocation<any, any, any>,
    private readonly children: BoundChildren,
    private readonly receptions: BoundReceptions,
  ) {
    this.facts = Object.freeze({
      get: <D extends ChildContract>(ref: ChildReference<D>) => this.fact(this.require(ref)) as ChildFact<D>,
      accepted: <D extends ChildContract, Value>(ref: ChildReference<D>, contract: ReceptionDefinition<NoInfer<D>, Value>): Value => {
        try {
          const entry = this.require(ref);
          const binding = this.receptions.require(contract, entry.definition as D);
          const reception = entry.relation.reception;
          if (reception.status !== 'accepted' || reception.contract !== binding) throw new Error('Child has no accepted value under this reception contract');
          return reception.output as Value;
        } catch (error) {
          this.parent.reject(error);
          throw error;
        }
      },
      require: <D extends ChildContract>(definition: D, ref: ChildReference) => {
        const entry = this.require(ref);
        if (entry.definition !== definition) return this.reject(new Error('Child reference belongs to a different declaration'));
        return this.fact(entry) as ChildFact<D>;
      },
      list: <D extends ChildContract>(definition: D, query?: { parentRound?: 1 | 2 }) =>
        Object.freeze(
          this.values()
            .filter((entry) => entry.definition === definition && (query?.parentRound === undefined || entry.relation.round === query.parentRound))
            .map((entry) => this.fact(entry) as ChildFact<D>),
        ),
      requireUnique: <D extends ChildContract>(definition: D, query: { parentRound: 1 | 2 }) => {
        const matches = this.facts.list(definition, query);
        if (matches.length !== 1) return this.reject(new Error('Expected exactly one direct child fact'));
        return matches[0]!;
      },
      values: () => Object.freeze(this.values().map((entry) => this.fact(entry))),
    });
  }

  forTarget<D extends ChildContract>(definition: D, target: InvocationTarget): ChildReference<D> {
    const relation = this.parent.children.get(target);
    const entry = this.entry(relation);
    if (entry.definition !== definition) return this.reject(new Error('Child declaration position differs from its binding'));
    return entry.ref as ChildReference<D>;
  }

  require(ref: ChildReference): ReferenceEntry {
    const entry = ref && typeof ref === 'object' ? this.#entries.get(ref) : undefined;
    if (!entry) return this.reject(new Error('Unknown or foreign child reference'));
    return entry;
  }

  fromSaved(value: CheckpointReference): ChildReference {
    const relation = this.parent.children.values().find((item) => item.invocation.context.id === value.contextId);
    if (!relation || value.parentContextId !== this.parent.context.id || relation.round !== value.parentRound || relation.order !== value.order || relation.declarationPosition !== value.target.position) return this.reject(new Error('Saved child reference does not match the installed relationship'));
    return this.entry(relation).ref;
  }

  encode(ref: ChildReference): CheckpointReference {
    const entry = this.require(ref);
    const relation = entry.relation;
    return Object.freeze({ contextId: relation.invocation.context.id, parentContextId: this.parent.context.id, parentRound: relation.round, order: relation.order, target: Object.freeze({ position: this.children.position(entry.definition) }) });
  }

  origin(origin: InvocationExceptionOrigin): ExceptionOrigin {
    if (origin.kind === 'self') return origin;
    const identity = origin.child;
    const relation = this.parent.children.values().find((item) => item.invocation.context.id === identity.childContextId);
    if (!relation || identity.parentContextId !== this.parent.context.id || identity.parentRound !== relation.round || identity.order !== relation.order) return this.reject(new Error('Exception source is not an exact direct child relationship'));
    return Object.freeze({ kind: origin.kind, child: this.entry(relation).ref });
  }

  continuation(value: InvocationContinuationFact | undefined): ContinuationFact | undefined {
    return value ? Object.freeze({ fromRound: value.fromRound, stage: value.stage, reason: value.reason, ...(value.origin ? { origin: this.origin(value.origin) } : {}) }) : undefined;
  }

  private values(): readonly ReferenceEntry[] {
    return this.parent.children.values().map((relation) => this.entry(relation));
  }

  private entry(relation: InvocationRelation): ReferenceEntry {
    const existing = this.#relations.get(relation);
    if (existing) return existing;
    const position = relation.declarationPosition;
    if (position === undefined) return this.reject(new Error('Direct child has no registered declaration position'));
    const definition = this.children.at(position);
    // Only this registry can grant authority. The opaque public type is not an identity proof.
    const ref = Object.freeze({}) as ChildReference;
    const entry = Object.freeze({ definition, relation, ref });
    this.#relations.set(relation, entry);
    this.#entries.set(ref, entry);
    return entry;
  }

  private fact(entry: ReferenceEntry): ChildFact {
    const relation = entry.relation;
    const target = relation.invocation;
    const context = target.context;
    const returned = relation.returned;
    const signal = 'signal' in context ? context.signal : undefined;
    const result = returned?.status === 'succeeded' ? Object.freeze({ status: 'succeeded' as const, output: returned.output }) : returned ? (signal instanceof AbortSignal && isInvocationCancelled(returned.error, signal) ? Object.freeze({ status: 'cancelled' as const, diagnostic: returned.diagnostic ?? RuntimeErrorHelper.format(returned.error) }) : Object.freeze({ status: 'failed' as const, diagnostic: returned.diagnostic ?? RuntimeErrorHelper.format(returned.error), ...(returned.failure ? { failure: Object.freeze(failureFact(returned.failure)) } : {}) })) : undefined;
    const reception = relation.reception;
    const received = reception.status === 'accepted' ? Object.freeze({ status: 'accepted' as const, value: reception.output }) : reception.status === 'failed' ? Object.freeze({ status: 'failed' as const, diagnostic: reception.diagnostic ?? RuntimeErrorHelper.format(reception.error), ...(reception.failure ? { failure: Object.freeze(failureFact(reception.failure)) } : {}) }) : Object.freeze({ status: reception.status });
    return Object.freeze({ ref: entry.ref, ...(relation.key ? { key: relation.key } : {}), parentRound: relation.round as 1 | 2, order: relation.order, input: context.input, returned: result, reception: received, ...(context.progress.round ? { progress: Object.freeze({ round: context.progress.round as 1 | 2, currentInput: context.currentInput, phase: context.progress.phase }) } : {}) });
  }

  private reject(error: Error): never {
    this.parent.reject(error);
    throw error;
  }
}
