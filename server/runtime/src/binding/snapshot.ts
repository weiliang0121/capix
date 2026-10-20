import type { SceneDefinition } from '../definition/scene.js';
import type { GroupDefinition } from '../definition/group.js';
import type { NodeDefinition } from '../definition/node.js';
import type { CallableDefinition, InvocationCheckpointDefinition, InvocationCheckpointPoint } from '../definition/callable.js';
import type { ObservationDeclaration } from '../definition/observation.js';
import type { CallableKind } from '@capix/protocol';
import type { CheckpointCodec } from '../checkpoint/contract.js';
import type { invocationSignature } from '../definition/signature.js';
import type { DefinitionReceptions, ReceptionDefinition } from '../definition/reception.js';
import type { ChildContract } from '../definition/children.js';

type AnyDefinition = SceneDefinition<any, any, any, any, any> | GroupDefinition<any, any, any, any, any> | NodeDefinition<any, any, any, any, any>;

/** Freeze interpreted contracts and member identity while preserving business receivers. */
export function snapshotDefinition<Definition extends AnyDefinition>(definition: Definition): Definition {
  const members = 'members' in definition ? definition.members : undefined;
  if (definition.kind === 'node' && members !== undefined) throw new Error('Nodes cannot declare members');
  if (definition.kind === 'node' && definition.receptions !== undefined) throw new Error('Nodes cannot declare receptions');
  const fixed = {
    ...snapshotInvocation<any, any, any, any, any, any>(definition),
    kind: definition.kind,
    name: definition.name,
    label: definition.label,
    source: definition.source,
    callee: definition.callee,
    ...(members ? { members: Object.freeze([...members]) } : {}),
  };
  return Object.freeze(fixed) as Definition;
}

function snapshotInvocation<Input, Output, Kind extends CallableKind, Resources extends object, ExceptionResources extends object, Delta>(definition: CallableDefinition<Input, Output, Kind, Resources, ExceptionResources, Delta>): CallableDefinition<Input, Output, Kind, Resources, ExceptionResources, Delta> {
  const run = definition.run;
  const exceptions = definition.exceptions;
  const output = definition.output;
  const fixed = Object.freeze({
    kind: definition.kind,
    maxRounds: definition.maxRounds,
    raises: Object.freeze([...(definition.raises ?? [])]),
    output: output ? Object.freeze({ result: output.result.bind(output), delta: output.delta?.bind(output) }) : undefined,
    run: Object.freeze({ requires: Object.freeze({ ...run.requires }), uses: run.uses ? Object.freeze([...run.uses]) : undefined, execute: run.execute.bind(run), accept: run.accept?.bind(run) }),
    exceptions: exceptions ? Object.freeze({ requires: Object.freeze({ ...exceptions.requires }), uses: exceptions.uses ? Object.freeze([...exceptions.uses]) : undefined, accepts: Object.freeze([...exceptions.accepts]), handle: exceptions.handle.bind(exceptions) }) : undefined,
    observation: definition.observation ? Object.freeze(definition.observation.map(snapshotObservation)) : undefined,
    checkpoint: definition.checkpoint ? snapshotCheckpoint(definition.checkpoint) : undefined,
    receptions: definition.receptions ? (Object.freeze(definition.receptions.map(snapshotReception)) as DefinitionReceptions<Kind>) : undefined,
  } satisfies Omit<CallableDefinition<Input, Output, Kind, Resources, ExceptionResources, Delta>, typeof invocationSignature>);
  // All runtime fields are checked above. Preserve the input's type-only I/O
  // witness without creating a symbol value or treating it as runtime identity.
  return fixed as typeof fixed & Pick<CallableDefinition<Input, Output, Kind, Resources, ExceptionResources, Delta>, typeof invocationSignature>;
}

const receptionOrigins = new WeakMap<object, object>();

/** The fixed interpreter retains the declaration object's registration identity. */
export function originalReception(reception: object): object {
  return receptionOrigins.get(reception) ?? reception;
}

function snapshotReception<Definition extends ChildContract, Value>(reception: ReceptionDefinition<Definition, Value>): ReceptionDefinition<Definition, Value> {
  const value = reception.value;
  if (typeof value?.check !== 'function' || typeof value.encode !== 'function' || typeof value.decode !== 'function') throw new Error('Reception requires check, encode and decode functions');
  const fixed = Object.freeze({ child: reception.child, value: Object.freeze({ check: value.check.bind(value), encode: value.encode.bind(value), decode: value.decode.bind(value) }) }) as ReceptionDefinition<Definition, Value>;
  receptionOrigins.set(fixed, originalReception(reception));
  return fixed;
}

function snapshotObservation<Fact>(declaration: ObservationDeclaration<Fact>): ObservationDeclaration<Fact> {
  return Object.freeze({ requires: Object.freeze({ ...declaration.requires }), failure: declaration.failure, observe: declaration.observe.bind(declaration) });
}

function snapshotCodec<Value>(codec: CheckpointCodec<Value>): CheckpointCodec<Value> {
  return Object.freeze({ encode: codec.encode.bind(codec), decode: codec.decode.bind(codec) });
}

function snapshotCheckpoint<Input, Output, Kind extends CallableKind, Delta>(checkpoint: InvocationCheckpointDefinition<Input, Output, Kind, Delta>): InvocationCheckpointDefinition<Input, Output, Kind, Delta> {
  return Object.freeze({
    key: checkpoint.key,
    version: checkpoint.version,
    input: snapshotCodec(checkpoint.input),
    output: snapshotCodec(checkpoint.output),
    points: Object.freeze(checkpoint.points.map(snapshotCheckpointPoint)),
  });
}

const pointOrigins = new WeakMap<object, object>();

export function originalCheckpointPoint(point: object): object {
  return pointOrigins.get(point) ?? point;
}

function snapshotCheckpointPoint<Input, Output, Kind extends CallableKind, State, Resources extends object, Slots extends InvocationCheckpointPoint<Input, Output, Kind, State>['references'], Allowed extends import('../definition/children.js').ChildContractsOf<Kind>, Delta>(point: InvocationCheckpointPoint<Input, Output, Kind, State, Resources, Slots, Allowed, Delta>): InvocationCheckpointPoint<Input, Output, Kind, State, Resources, Slots, Allowed, Delta> {
  const resume = point.resume;
  const fixed = Object.freeze({
    name: point.name,
    state: snapshotCodec(point.state),
    references: Object.freeze(Object.fromEntries(Object.entries(point.references).map(([name, slot]) => [name, Object.freeze({ ...slot })]))) as Slots,
    check: point.check?.bind(point),
    resume: Object.freeze({ requires: Object.freeze({ ...resume.requires }), uses: resume.uses ? Object.freeze([...resume.uses]) : undefined, execute: resume.execute.bind(resume) }),
  });
  pointOrigins.set(fixed, originalCheckpointPoint(point));
  return fixed;
}
