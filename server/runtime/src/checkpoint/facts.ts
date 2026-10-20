import type { RuntimeErrorDetail, RuntimeErrorValue } from '@capix/protocol';
import type { CheckpointChild, CheckpointChildReception, CheckpointReferences, InvocationCheckpointFrame, CheckpointValue } from './contract.js';
import type { CheckpointBinding, CheckpointChildBinding, CheckpointReferenceSlot } from './work.js';
import { checkpointReferenceChild } from './value.js';
import type { InvocationReceptionBinding } from '../invocation/reception.js';

type ChildProgress = { readonly round: number; readonly currentInput: unknown; readonly phase: 'execute' | 'receive' | 'handling' };
export type DecodedCheckpointReception = Exclude<CheckpointChildReception, { readonly kind: 'accepted' }> | (Omit<Extract<CheckpointChildReception, { readonly kind: 'accepted' }>, 'output'> & { readonly output?: unknown });
export type DecodedCheckpointChild = Omit<CheckpointChild, 'input' | 'state'> & {
  readonly input: unknown;
  readonly state: { readonly kind: 'waiting' } | { readonly kind: 'returned'; readonly output: unknown; readonly progress: ChildProgress; readonly reception: DecodedCheckpointReception } | (Omit<Extract<CheckpointChild['state'], { kind: 'failed' }>, 'progress'> & { readonly progress: ChildProgress });
};
export type DecodedCheckpointFrame = Omit<InvocationCheckpointFrame, 'input' | 'currentInput' | 'children'> & { readonly input: unknown; readonly currentInput: unknown; readonly children: readonly DecodedCheckpointChild[] };

/** A persisted position is meaningful only inside this parent's fixed contract. */
export function checkpointChildBinding(child: CheckpointChild, children: readonly CheckpointChildBinding[] = []): CheckpointBinding | undefined {
  const target = children[child.target.position];
  if (!target || target.kind !== child.identity.kind || target.binding?.key !== child.contract?.key || target.binding?.version !== child.contract?.version) throw new Error('Checkpoint child declaration position or contract is incompatible');
  return target.binding;
}

/** Reception positions belong to the parent contract and its exact direct child layout. */
export function checkpointReceptionBinding(child: CheckpointChild, receptions: readonly InvocationReceptionBinding[] = []): InvocationReceptionBinding | undefined {
  if (child.state.kind !== 'returned' || child.state.reception.kind === 'pending' || child.state.reception.contract === undefined) return undefined;
  const position = child.state.reception.contract.position;
  const binding = receptions[position];
  if (!binding || binding.position !== position || binding.childPosition !== child.target.position) throw new Error('Checkpoint reception contract position or child declaration is incompatible');
  return binding;
}

/** A codec is used only at the saved boundary; validation never substitutes a live result. */
export function decodeCheckpointReception(child: CheckpointChild, binding: InvocationReceptionBinding | undefined): DecodedCheckpointReception {
  if (child.state.kind !== 'returned') throw new Error('Only returned children have saved reception facts');
  const saved = child.state.reception;
  if (saved.kind !== 'accepted' || !binding) return saved;
  if (!Object.hasOwn(saved, 'output')) throw new Error('Contracted checkpoint reception requires encoded output');
  const output = binding.codec.decode(saved.output!);
  binding.check(output);
  return Object.freeze({ ...saved, output });
}

export function checkCheckpointReferences(frame: InvocationCheckpointFrame, references: CheckpointReferences, slots: Readonly<Record<string, CheckpointReferenceSlot>> = {}): void {
  if (Object.keys(references).length !== Object.keys(slots).length || Object.keys(references).some((name) => !Object.hasOwn(slots, name))) throw new Error('Checkpoint reference slots differ from the registered point');
  for (const [name, slot] of Object.entries(slots)) {
    const saved = references[name];
    if (!saved || (slot.cardinality === 'many') !== Array.isArray(saved)) throw new Error('Checkpoint reference cardinality differs from the registered point');
    const values = Array.isArray(saved) ? saved : [saved];
    for (const reference of values) if (checkpointReferenceChild(reference, frame.children).target.position !== slot.position) throw new Error('Checkpoint reference targets a different child declaration');
  }
}

/** Decode saved-time values once, without turning business values back into JSON. */
export function decodeCheckpointFrame(frame: InvocationCheckpointFrame, binding: CheckpointBinding, children: readonly CheckpointChildBinding[] = [], receptions: readonly InvocationReceptionBinding[] = []): DecodedCheckpointFrame {
  const decoded = frame.children.map((child): DecodedCheckpointChild => {
    const target = checkpointChildBinding(child, children);
    const input = target ? target.input.decode(child.input) : child.input;
    const saved = child.state;
    if (saved.kind === 'waiting') return Object.freeze({ ...child, input, state: saved });
    const progress = Object.freeze({ ...saved.progress, currentInput: target ? target.input.decode(saved.progress.currentInput) : saved.progress.currentInput });
    if (saved.kind === 'failed') return Object.freeze({ ...child, input, state: Object.freeze({ ...saved, progress }) });
    const reception = decodeCheckpointReception(child, checkpointReceptionBinding(child, receptions));
    return Object.freeze({ ...child, input, state: Object.freeze({ ...saved, progress, reception, output: target ? target.output.decode(saved.output) : saved.output }) });
  });
  return Object.freeze({ ...frame, input: binding.input.decode(frame.input), currentInput: binding.input.decode(frame.currentInput), children: Object.freeze(decoded) });
}

/** A stored diagnostic remains inert data; never format it as a new thrown Error. */
export function decodeCheckpointDiagnostic(value: CheckpointValue): RuntimeErrorValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved diagnostic');
  const data = value as Readonly<Record<string, CheckpointValue>>;
  if (typeof data.code !== 'string' || typeof data.message !== 'string') throw new Error('Invalid saved diagnostic code/message');
  if (data.name !== undefined && typeof data.name !== 'string') throw new Error('Invalid saved diagnostic name');
  if (data.stack !== undefined && typeof data.stack !== 'string') throw new Error('Invalid saved diagnostic stack');
  if (data.errors !== undefined && !Array.isArray(data.errors)) throw new Error('Invalid saved diagnostic errors');
  const errors = Array.isArray(data.errors) ? data.errors.map(decodeCheckpointDiagnostic) : undefined;
  if (errors) Object.freeze(errors);
  return Object.freeze({ code: data.code, message: data.message, ...(data.name !== undefined ? { name: data.name } : {}), ...(data.stack !== undefined ? { stack: data.stack } : {}), ...(data.detail !== undefined ? { detail: data.detail as RuntimeErrorDetail } : {}), ...(data.cause !== undefined ? { cause: decodeCheckpointDiagnostic(data.cause) } : {}), ...(errors ? { errors } : {}) });
}
