import { randomUUID } from 'node:crypto';
import { stableValue, type CheckpointCodec, type CheckpointValue } from '@weiliang0121/capix-contracts';
import { cloneCheckpointValue, createCheckpointValueBlock, type CheckpointValueBlock, type CheckpointValueReference, type CheckpointChild, type CheckpointChildRecord } from '@weiliang0121/capix-checkpoint';
import type { InvocationContext } from '../context/context.js';
import type { InvocationRelation } from '../invocation/relation.js';
import type { DecodedCheckpointChild } from './facts.js';
import { captureCheckpointChild } from './children.js';
import { decodeCheckpointData, encodeCheckpointData, runCheckpointCheck, checkpointDataEqual } from './data.js';

export interface PublishedCheckpointValue {
  readonly source: unknown;
  readonly encoded: CheckpointValue;
  readonly reference: CheckpointValueReference;
}

export interface PublishedCheckpointChild {
  readonly values: Map<string, PublishedCheckpointValue>;
  readonly encoded: CheckpointChild;
  readonly decoded: DecodedCheckpointChild;
  readonly record: CheckpointChildRecord;
}

/** Fix the representation of one established fact, never an arbitrary mutable codec cache. */
export function encodeCheckpointFact(value: unknown, codec: CheckpointCodec<any> | undefined, check?: (value: unknown) => void): Pick<PublishedCheckpointValue, 'source' | 'encoded'> {
  const source = stableValue(value);
  const encoded = codec ? cloneCheckpointValue(codec.encode(source)) : encodeCheckpointData(source);
  const decoded = codec ? stableValue(codec.decode(encoded)) : decodeCheckpointData(encoded);
  if (!checkpointDataEqual(source, decoded)) throw new Error('Checkpoint codec must preserve the established value');
  if (check) runCheckpointCheck(() => check(decoded));
  return Object.freeze({ source, encoded });
}

export function publishCheckpointValue(value: unknown, codec: CheckpointCodec<any> | undefined, blocks: CheckpointValueBlock[], check?: (value: unknown) => void): PublishedCheckpointValue {
  const { source, encoded } = encodeCheckpointFact(value, codec, check);
  const block = createCheckpointValueBlock(randomUUID(), encoded);
  blocks.push(block);
  return Object.freeze({ source, encoded, reference: Object.freeze({ id: block.id, digest: block.digest }) });
}

export function publishCheckpointChild(context: InvocationContext<any, any>, relation: InvocationRelation, saved: CheckpointChild | undefined, previous: PublishedCheckpointChild | undefined, blocks: CheckpointValueBlock[]): PublishedCheckpointChild {
  const values = new Map(previous?.values);
  const encode = (role: string, source: unknown, codec?: CheckpointCodec<any>): CheckpointValue => {
    const established = values.get(role);
    if (established) {
      if (!Object.is(established.source, source)) throw new Error(`Established child ${role} changed`);
      return established.encoded;
    }
    const input = values.get('input');
    if (role === 'currentInput' && input && Object.is(input.source, source)) {
      values.set(role, input);
      return input.encoded;
    }
    const reception = relation.reception;
    const value = publishCheckpointValue(source, codec, blocks, role === 'reception' && reception.status !== 'pending' ? reception.contract?.check : undefined);
    values.set(role, value);
    return value.encoded;
  };
  const encoded = freezeCheckpointChildMetadata(captureCheckpointChild(context, relation, saved, encode));
  const value = (role: string) => {
    const found = values.get(role);
    if (!found) throw new Error(`Checkpoint child ${role} has no publication`);
    return found;
  };
  const state = encoded.state;
  const reception = state.kind === 'waiting' ? undefined : state.reception;
  const decodedReception = reception && (reception.kind === 'accepted' || reception.kind === 'handled') && Object.hasOwn(reception, 'output') ? Object.freeze({ ...reception, output: value('reception').source }) : reception;
  const recordReception = reception && (reception.kind === 'accepted' || reception.kind === 'handled') && Object.hasOwn(reception, 'output') ? Object.freeze({ ...reception, output: value('reception').reference }) : reception?.kind === 'failed' ? Object.freeze({ ...reception, error: value('receptionFailure').reference }) : reception;
  const decodedState = state.kind === 'waiting' ? state : Object.freeze({ ...state, ...(state.kind === 'returned' ? { output: value('output').source } : {}), progress: Object.freeze({ ...state.progress, currentInput: value('currentInput').source }), ...(decodedReception ? { reception: decodedReception } : {}) });
  const recordState = state.kind === 'waiting' ? state : Object.freeze({ ...state, ...(state.kind === 'returned' ? { output: value('output').reference } : { error: value('failure').reference }), progress: Object.freeze({ ...state.progress, currentInput: value('currentInput').reference }), ...(recordReception ? { reception: recordReception } : {}) });
  return Object.freeze({ values, encoded: Object.freeze(encoded), decoded: Object.freeze({ ...encoded, input: value('input').source, state: decodedState }) as DecodedCheckpointChild, record: Object.freeze({ ...encoded, input: value('input').reference, state: recordState }) as CheckpointChildRecord });
}

/** Cold reads carry their exact physical references; decoded values are newly checked facts. */
export function restoredCheckpointChild(encoded: CheckpointChild, decoded: DecodedCheckpointChild, record: CheckpointChildRecord, relation: InvocationRelation): PublishedCheckpointChild {
  const values = new Map<string, PublishedCheckpointValue>();
  const add = (role: string, source: unknown, wire: CheckpointValue, reference: CheckpointValueReference) => values.set(role, Object.freeze({ source, encoded: wire, reference }));
  add('input', relation.invocation.context.input, encoded.input, record.input);
  if (encoded.state.kind !== 'waiting' && decoded.state.kind !== 'waiting' && record.state.kind !== 'waiting') {
    add('currentInput', relation.invocation.context.currentInput, encoded.state.progress.currentInput, record.state.progress.currentInput);
    if (encoded.state.kind === 'returned' && decoded.state.kind === 'returned' && record.state.kind === 'returned') add('output', relation.returned?.status === 'succeeded' ? relation.returned.output : decoded.state.output, encoded.state.output, record.state.output);
    if (encoded.state.kind === 'failed' && record.state.kind === 'failed') add('failure', relation.returned?.status === 'failed' ? relation.returned.diagnostic : undefined, encoded.state.error, record.state.error);
    const a = encoded.state.reception;
    const b = decoded.state.reception;
    const c = record.state.reception;
    if (a && b && c && (a.kind === 'accepted' || a.kind === 'handled') && (b.kind === 'accepted' || b.kind === 'handled') && (c.kind === 'accepted' || c.kind === 'handled') && Object.hasOwn(a, 'output')) add('reception', relation.reception.status === 'accepted' || relation.reception.status === 'handled' ? relation.reception.output : b.output, a.output!, c.output!);
  }
  return Object.freeze({ values, encoded, decoded, record });
}

/** Freeze the small relation envelope without traversing already-fixed value bodies. */
function freezeCheckpointChildMetadata(child: CheckpointChild): CheckpointChild {
  const base = {
    ...child,
    identity: Object.freeze({ ...child.identity }),
    target: Object.freeze({ ...child.target }),
    ...(child.contract ? { contract: Object.freeze({ ...child.contract }) } : {}),
  };
  const state = child.state;
  if (state.kind === 'waiting') return Object.freeze({ ...base, state: Object.freeze({ ...state }) });
  const reception = state.reception;
  const fixedReception = reception
    ? Object.freeze({
        ...reception,
        ...('contract' in reception && reception.contract ? { contract: Object.freeze({ ...reception.contract }) } : {}),
        ...('failure' in reception ? { failure: Object.freeze({ ...reception.failure }) } : {}),
      })
    : undefined;
  return Object.freeze({
    ...base,
    state: Object.freeze({
      ...state,
      progress: Object.freeze({ ...state.progress }),
      ...(state.kind === 'failed' ? { failure: Object.freeze({ ...state.failure }) } : {}),
      ...(fixedReception ? { reception: fixedReception } : {}),
    }),
  }) as CheckpointChild;
}
