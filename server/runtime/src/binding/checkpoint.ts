import type { CheckpointReferences, CheckpointReference } from '@capix/checkpoint';
import { decodeCheckpointDiagnostic, type DecodedCheckpointFrame, type DecodedCheckpointChild } from '@capix/invocation';
import type { Stable, CheckpointFacts, ChildContract, ChildFact, ChildFacts, ChildReference, ContinuationFact, ReceptionDefinition } from '@capix/contracts';
import type { BoundChildren } from './children/bound.js';
import { BoundReceptions } from './receptions.js';

/** Saved checks get decoded facts and inert references, never a live action registry. */
export function savedCheckpointFacts(frame: DecodedCheckpointFrame, references: CheckpointReferences, children: BoundChildren, receptions = new BoundReceptions([], children)): { readonly facts: CheckpointFacts<unknown>; close(): void } {
  let active = true;
  const requireOpen = () => {
    if (!active) throw new Error('Saved fact queries are only valid during the synchronous checkpoint check');
  };
  let fallback: Map<string, DecodedCheckpointChild> | undefined;
  const lookup = (id: string) => {
    requireOpen();
    if (frame.child) return frame.child(id);
    fallback ??= new Map(frame.children.map((child) => [child.identity.contextId, child]));
    return fallback.get(id);
  };
  const entries = new WeakMap<ChildReference, { readonly saved: DecodedCheckpointChild; readonly definition: ChildContract; readonly fact: ChildFact<ChildContract> }>();
  const byId = new Map<string, { readonly saved: DecodedCheckpointChild; readonly ref: ChildReference; readonly definition: ChildContract; readonly fact: ChildFact<ChildContract> }>();
  const materialize = (saved: DecodedCheckpointChild) => {
    requireOpen();
    const existing = byId.get(saved.identity.contextId);
    if (existing) return existing;
    const definition = children.at(saved.target.position);
    // This local registry issues only query authority. Live open/resume registries
    // deliberately do not recognize these point-check references.
    const ref = Object.freeze({}) as ChildReference<ChildContract>;
    const state = saved.state;
    const returned = state.kind === 'waiting' ? undefined : state.kind === 'returned' ? Object.freeze({ status: 'succeeded' as const, output: state.output }) : Object.freeze({ status: 'failed' as const, diagnostic: decodeCheckpointDiagnostic(state.error), failure: state.failure });
    const reception = state.kind === 'failed' && state.reception ? Object.freeze({ status: 'handled' as const, value: state.reception.output }) : state.kind !== 'returned' ? Object.freeze({ status: 'pending' as const }) : state.reception.kind === 'accepted' ? Object.freeze({ status: 'accepted' as const, value: state.reception.output }) : state.reception.kind === 'failed' ? Object.freeze({ status: 'failed' as const, diagnostic: decodeCheckpointDiagnostic(state.reception.error), failure: state.reception.failure }) : Object.freeze({ status: state.reception.kind });
    const fact: ChildFact<ChildContract> = Object.freeze({ ref, ...(saved.key !== undefined ? { key: saved.key } : {}), parentRound: round(saved.round), order: saved.order, input: saved.input, returned, reception, ...(state.kind !== 'waiting' ? { progress: Object.freeze({ ...state.progress, round: round(state.progress.round) }) } : {}) });
    const entry = Object.freeze({ saved, ref, definition, fact });
    entries.set(ref, entry);
    byId.set(saved.identity.contextId, entry);
    return entry;
  };
  const requireEntry = (ref: ChildReference) => {
    requireOpen();
    const entry = ref && typeof ref === 'object' ? entries.get(ref) : undefined;
    if (!entry) throw new Error('Unknown or foreign saved child reference');
    return entry;
  };
  const selected = (wire: CheckpointReference) => {
    const saved = lookup(wire.contextId);
    const entry = saved ? materialize(saved) : undefined;
    if (!entry || !saved || wire.parentContextId !== frame.owner.contextId || wire.parentRound !== saved.round || wire.order !== saved.order || wire.target.position !== saved.target.position) throw new Error('Saved child reference differs from the checked frame');
    return entry;
  };
  const facts: ChildFacts = Object.freeze({
    get: <Definition extends ChildContract>(ref: ChildReference<Definition>) => requireEntry(ref).fact as ChildFact<Definition>,
    accepted: <Definition extends ChildContract, Value>(ref: ChildReference<Definition>, contract: ReceptionDefinition<NoInfer<Definition>, Value>): Stable<Value> => {
      const entry = requireEntry(ref);
      const binding = receptions.require(contract, entry.definition as Definition);
      const state = entry.saved.state;
      if (state.kind !== 'returned' || state.reception.kind !== 'accepted' || state.reception.contract?.position !== binding.position) throw new Error('Saved child has no accepted value under this reception contract');
      return state.reception.output as Stable<Value>;
    },
    handled: <Definition extends ChildContract, Value>(ref: ChildReference<Definition>, contract: ReceptionDefinition<NoInfer<Definition>, Value>): Stable<Value> => {
      const entry = requireEntry(ref);
      const binding = receptions.require(contract, entry.definition as Definition);
      const state = entry.saved.state;
      if (state.kind !== 'failed' || state.reception?.kind !== 'handled' || state.reception.contract?.position !== binding.position) throw new Error('Saved child has no handled value under this reception contract');
      return state.reception.output as Stable<Value>;
    },
    require: <Definition extends ChildContract>(definition: Definition, ref: ChildReference) => {
      const entry = requireEntry(ref);
      if (entry.definition !== definition) throw new Error('Saved child reference belongs to a different declaration');
      return entry.fact as ChildFact<Definition>;
    },
    list: <Definition extends ChildContract>(definition: Definition, query?: { readonly parentRound?: 1 | 2 }) => {
      requireOpen();
      return Object.freeze(
        frame.children
          .map(materialize)
          .filter((entry) => entry.definition === definition && (query?.parentRound === undefined || entry.saved.round === query.parentRound))
          .map((entry) => entry.fact as ChildFact<Definition>),
      );
    },
    requireUnique: <Definition extends ChildContract>(definition: Definition, query: { readonly parentRound: 1 | 2 }) => {
      const matches = facts.list(definition, query);
      if (matches.length !== 1) throw new Error('Expected exactly one saved direct child fact');
      return matches[0]!;
    },
    values: () => {
      requireOpen();
      return Object.freeze(frame.children.map((saved) => materialize(saved).fact));
    },
  });
  const slots: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(references))
    Object.defineProperty(slots, key, {
      enumerable: true,
      get() {
        requireOpen();
        return Array.isArray(value) ? Object.freeze(value.map((item) => selected(item).fact)) : selected(value as CheckpointReference).fact;
      },
    });
  Object.freeze(slots);
  let continuation: ContinuationFact | undefined;
  if (frame.continuation) {
    const { origin, ...accepted } = frame.continuation;
    continuation = Object.freeze({ ...accepted, ...(origin ? { origin: origin.kind === 'self' ? origin : Object.freeze({ kind: origin.kind, child: selected(origin.child).ref }) } : {}) });
  }
  return Object.freeze({
    facts: Object.freeze({ initialInput: frame.input, input: frame.currentInput, round: round(frame.round), ...(continuation ? { continuation } : {}), references: slots as CheckpointFacts<unknown>['references'], children: facts }),
    close() {
      active = false;
    },
  });
}

function round(value: number): 1 | 2 {
  if (value !== 1 && value !== 2) throw new Error('Invalid saved invocation round');
  return value;
}
