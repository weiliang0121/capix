import type { RuntimeDefinition } from '../definition/runtime.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { OperationDefinition } from '../definition/operation.js';
import type { AttemptDefinition } from '../definition/attempt.js';
import type { InvocationDefinition, InvocationCheckpointDefinition, InvocationCheckpointPoint } from '../definition/invocation.js';
import type { ObservationDeclaration } from '../definition/observation.js';
import type { InvocationLevel } from '@capix/protocol';
import type { CheckpointCodec } from '../checkpoint/contract.js';
import type { invocationSignature } from '../definition/signature.js';
import type { DefinitionReceptions, ReceptionDefinition } from '../definition/reception.js';
import type { ChildContract } from '../definition/children.js';

// Heterogeneous traversal erases only the pairing already retained by the overloads.
type AnyDefinition = RuntimeDefinition<any, any, any, any, any> | ExecutionDefinition<any, any, any, any, any> | OperationDefinition<any, any, any, any, any> | AttemptDefinition<any, any, any, any, any>;

/** Fix interpreted contracts and method entries without copying or freezing business instances. */
export function snapshotDefinition<Input, Output, Resources extends object, ExceptionResources extends object, Delta>(definition: RuntimeDefinition<Input, Output, Resources, ExceptionResources, Delta>): RuntimeDefinition<Input, Output, Resources, ExceptionResources, Delta>;
export function snapshotDefinition<Input, Output, Resources extends object, ExceptionResources extends object, Delta>(definition: ExecutionDefinition<Input, Output, Resources, ExceptionResources, Delta>): ExecutionDefinition<Input, Output, Resources, ExceptionResources, Delta>;
export function snapshotDefinition<Input, Output, Resources extends object, ExceptionResources extends object, Delta>(definition: OperationDefinition<Input, Output, Resources, ExceptionResources, Delta>): OperationDefinition<Input, Output, Resources, ExceptionResources, Delta>;
export function snapshotDefinition<Input, Output, Resources extends object, ExceptionResources extends object, Delta>(definition: AttemptDefinition<Input, Output, Resources, ExceptionResources, Delta>): AttemptDefinition<Input, Output, Resources, ExceptionResources, Delta>;
export function snapshotDefinition(definition: AnyDefinition): AnyDefinition;
export function snapshotDefinition(definition: AnyDefinition): AnyDefinition {
  switch (definition.level) {
    case 'runtime':
      return Object.freeze({ ...snapshotInvocation(definition), level: definition.level, children: Object.freeze([...definition.children]) });
    case 'execution':
      return Object.freeze({ ...snapshotInvocation(definition), level: definition.level, children: Object.freeze([...definition.children]) });
    case 'operation':
      return Object.freeze({ ...snapshotInvocation(definition), level: definition.level, children: Object.freeze([...definition.children]), name: definition.name, label: definition.label, source: definition.source });
    case 'attempt':
      if (definition.children !== undefined) throw new Error('Attempts cannot declare children');
      if (definition.receptions !== undefined) throw new Error('Attempts cannot declare receptions');
      return Object.freeze({ ...snapshotInvocation(definition), level: definition.level, name: definition.name, label: definition.label, source: definition.source, callee: definition.callee });
  }
}

function snapshotInvocation<Input, Output, Level extends InvocationLevel, Resources extends object, ExceptionResources extends object, Delta>(definition: InvocationDefinition<Input, Output, Level, Resources, ExceptionResources, Delta>): InvocationDefinition<Input, Output, Level, Resources, ExceptionResources, Delta> {
  const run = definition.run;
  const exceptions = definition.exceptions;
  const output = definition.output;
  const fixed = Object.freeze({
    maxRounds: definition.maxRounds,
    raises: Object.freeze([...(definition.raises ?? [])]),
    output: output ? Object.freeze({ result: output.result.bind(output), delta: output.delta?.bind(output) }) : undefined,
    run: Object.freeze({ requires: Object.freeze({ ...run.requires }), uses: run.uses ? Object.freeze([...run.uses]) : undefined, execute: run.execute.bind(run), accept: run.accept?.bind(run) }),
    exceptions: exceptions ? Object.freeze({ requires: Object.freeze({ ...exceptions.requires }), uses: exceptions.uses ? Object.freeze([...exceptions.uses]) : undefined, accepts: Object.freeze([...exceptions.accepts]), handle: exceptions.handle.bind(exceptions) }) : undefined,
    observation: definition.observation ? Object.freeze(definition.observation.map(snapshotObservation)) : undefined,
    checkpoint: definition.checkpoint ? snapshotCheckpoint(definition.checkpoint) : undefined,
    receptions: definition.receptions ? (Object.freeze(definition.receptions.map(snapshotReception)) as DefinitionReceptions<Level>) : undefined,
  } satisfies Omit<InvocationDefinition<Input, Output, Level, Resources, ExceptionResources, Delta>, typeof invocationSignature>);
  // All runtime fields are checked above. Preserve the input's type-only I/O
  // witness without creating a symbol value or treating it as runtime identity.
  return fixed as typeof fixed & Pick<InvocationDefinition<Input, Output, Level, Resources, ExceptionResources, Delta>, typeof invocationSignature>;
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

function snapshotCheckpoint<Input, Output, Level extends InvocationLevel, Delta>(checkpoint: InvocationCheckpointDefinition<Input, Output, Level, Delta>): InvocationCheckpointDefinition<Input, Output, Level, Delta> {
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

function snapshotCheckpointPoint<Input, Output, Level extends InvocationLevel, State, Resources extends object, Slots extends InvocationCheckpointPoint<Input, Output, Level, State>['references'], Allowed extends import('../definition/children.js').ChildContractsOf<Level>, Delta>(point: InvocationCheckpointPoint<Input, Output, Level, State, Resources, Slots, Allowed, Delta>): InvocationCheckpointPoint<Input, Output, Level, State, Resources, Slots, Allowed, Delta> {
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
