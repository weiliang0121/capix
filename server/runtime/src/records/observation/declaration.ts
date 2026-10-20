import type { InvocationRelationIdentity } from '@capix/protocol';
import { defineObservation } from '../../definition/observation.js';
import type { InvocationFact } from '../../observation/facts.js';
import { ResourceOffer } from '../../resource/offer.js';
import type { InvocationRecording } from './invocation.js';

export interface InvocationRecordDescription<Input = unknown, Output = unknown> {
  /** Host interpretation; does not change execution or invocation ownership. */
  readonly role?: string;
  readonly input?: (input: Input) => unknown;
  readonly output?: (output: Output) => unknown;
  /** Parent acceptance may produce a different value from the child's returned output. */
  readonly relationAccepted?: (output: unknown, relation: InvocationRelationIdentity) => unknown;
}
export interface InvocationRecordWriter {
  observe(fact: InvocationFact, description?: InvocationRecordDescription): undefined;
}

/** Only observation declarations may request this locally supplied writer. */
export const InvocationRecordAccess = new ResourceOffer<InvocationRecording, InvocationRecordWriter>('observation.call-record', (recording, activity) =>
  Object.freeze({
    observe(fact: InvocationFact, description?: InvocationRecordDescription): undefined {
      activity.validate();
      recording.observeDescribed(fact, description);
      return undefined;
    },
  }),
);

/** Call records are produced here, not by an implicit Invocation recording path. */
export function invocationRecording<Input = unknown, Output = unknown>(description: InvocationRecordDescription<Input, Output> = {}, options: { failure?: 'isolate' | 'propagate' } = {}) {
  const mapped: InvocationRecordDescription = {
    ...(description.role !== undefined ? { role: description.role } : {}),
    ...(description.input ? { input: (input: unknown) => description.input!(input as Input) } : {}),
    ...(description.output ? { output: (output: unknown) => description.output!(output as Output) } : {}),
    ...(description.relationAccepted ? { relationAccepted: description.relationAccepted } : {}),
  };
  return defineObservation<InvocationFact, { record: InvocationRecordWriter }>(
    {
      requires: { record: InvocationRecordAccess.request() },
      observe(fact, ports) {
        return ports.record.observe(fact, mapped);
      },
    },
    options,
  );
}
