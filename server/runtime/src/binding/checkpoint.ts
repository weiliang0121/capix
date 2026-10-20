import type { CheckpointReferences, CheckpointReference } from '../checkpoint/contract.js';
import { decodeCheckpointDiagnostic, type DecodedCheckpointFrame, type DecodedCheckpointChild } from '../checkpoint/facts.js';
import type { CheckpointFacts } from '../definition/checkpoint.js';
import type { ChildContract, ChildFact, ChildFacts, ChildReference } from '../definition/children.js';
import type { ContinuationFact } from '../definition/work.js';
import type { BoundChildren } from './children/bound.js';
import { BoundReceptions } from './receptions.js';
import type { ReceptionDefinition } from '../definition/reception.js';

/** Saved checks get decoded facts and inert references, never a live action registry. */
export function savedCheckpointFacts(frame: DecodedCheckpointFrame, references: CheckpointReferences, children: BoundChildren, receptions = new BoundReceptions([], children)): CheckpointFacts<unknown> {
  const entries = new WeakMap<ChildReference, { readonly saved: DecodedCheckpointChild; readonly definition: ChildContract; readonly fact: ChildFact<ChildContract> }>();
  const byId = new Map<string, { readonly saved: DecodedCheckpointChild; readonly ref: ChildReference; readonly definition: ChildContract; readonly fact: ChildFact<ChildContract> }>();
  for (const saved of frame.children) {
    const definition = children.at(saved.target.position);
    // This local registry issues only query authority. Live open/resume registries
    // deliberately do not recognize these point-check references.
    const ref = Object.freeze({}) as ChildReference<ChildContract>;
    const state = saved.state;
    const returned = state.kind === 'waiting' ? undefined : state.kind === 'returned' ? Object.freeze({ status: 'succeeded' as const, output: state.output }) : Object.freeze({ status: 'failed' as const, diagnostic: decodeCheckpointDiagnostic(state.error), failure: state.failure });
    const reception = state.kind !== 'returned' ? Object.freeze({ status: 'pending' as const }) : state.reception.kind === 'accepted' ? Object.freeze({ status: 'accepted' as const, value: state.reception.output }) : state.reception.kind === 'failed' ? Object.freeze({ status: 'failed' as const, diagnostic: decodeCheckpointDiagnostic(state.reception.error), failure: state.reception.failure }) : Object.freeze({ status: state.reception.kind });
    const fact: ChildFact<ChildContract> = Object.freeze({ ref, ...(saved.key !== undefined ? { key: saved.key } : {}), parentRound: round(saved.round), order: saved.order, input: saved.input, returned, reception, ...(state.kind !== 'waiting' ? { progress: Object.freeze({ ...state.progress, round: round(state.progress.round) }) } : {}) });
    const entry = Object.freeze({ saved, ref, definition, fact });
    entries.set(ref, entry);
    byId.set(saved.identity.contextId, entry);
  }
  const requireEntry = (ref: ChildReference) => {
    const entry = ref && typeof ref === 'object' ? entries.get(ref) : undefined;
    if (!entry) throw new Error('Unknown or foreign saved child reference');
    return entry;
  };
  const selected = (wire: CheckpointReference) => {
    const entry = byId.get(wire.contextId);
    const saved = entry?.saved;
    if (!entry || !saved || wire.parentContextId !== frame.owner.contextId || wire.parentRound !== saved.round || wire.order !== saved.order || wire.target.position !== saved.target.position) throw new Error('Saved child reference differs from the checked frame');
    return entry;
  };
  const facts: ChildFacts = Object.freeze({
    get: <Definition extends ChildContract>(ref: ChildReference<Definition>) => requireEntry(ref).fact as ChildFact<Definition>,
    accepted: <Definition extends ChildContract, Value>(ref: ChildReference<Definition>, contract: ReceptionDefinition<NoInfer<Definition>, Value>): Value => {
      const entry = requireEntry(ref);
      const binding = receptions.require(contract, entry.definition as Definition);
      const state = entry.saved.state;
      if (state.kind !== 'returned' || state.reception.kind !== 'accepted' || state.reception.contract?.position !== binding.position) throw new Error('Saved child has no accepted value under this reception contract');
      return state.reception.output as Value;
    },
    require: <Definition extends ChildContract>(definition: Definition, ref: ChildReference) => {
      const entry = requireEntry(ref);
      if (entry.definition !== definition) throw new Error('Saved child reference belongs to a different declaration');
      return entry.fact as ChildFact<Definition>;
    },
    list: <Definition extends ChildContract>(definition: Definition, query?: { readonly parentRound?: 1 | 2 }) => Object.freeze([...byId.values()].filter((entry) => entry.definition === definition && (query?.parentRound === undefined || entry.saved.round === query.parentRound)).map((entry) => entry.fact as ChildFact<Definition>)),
    requireUnique: <Definition extends ChildContract>(definition: Definition, query: { readonly parentRound: 1 | 2 }) => {
      const matches = facts.list(definition, query);
      if (matches.length !== 1) throw new Error('Expected exactly one saved direct child fact');
      return matches[0]!;
    },
    values: () => Object.freeze([...byId.values()].map((entry) => entry.fact)),
  });
  const slots = Object.freeze(Object.fromEntries(Object.entries(references).map(([key, value]) => [key, Array.isArray(value) ? Object.freeze(value.map((item) => selected(item).fact)) : selected(value as CheckpointReference).fact])));
  let continuation: ContinuationFact | undefined;
  if (frame.continuation) {
    const { origin, ...accepted } = frame.continuation;
    continuation = Object.freeze({ ...accepted, ...(origin ? { origin: origin.kind === 'self' ? origin : Object.freeze({ kind: origin.kind, child: selected(origin.child).ref }) } : {}) });
  }
  return Object.freeze({ initialInput: frame.input, input: frame.currentInput, round: round(frame.round), ...(continuation ? { continuation } : {}), references: slots, children: facts });
}

function round(value: number): 1 | 2 {
  if (value !== 1 && value !== 2) throw new Error('Invalid saved invocation round');
  return value;
}
