import type { InvocationRelationIdentity } from '@weiliang0121/capix-contracts';
import { defineObservation } from '../../definition/observation.js';
import type { InvocationFact } from '@weiliang0121/capix-invocation';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import type { InvocationRecording } from './invocation.js';

export interface InvocationRecordDescription<Input = unknown, Output = unknown> {
  /** Host interpretation; does not change execution or invocation ownership. */
  readonly role?: string;
  readonly input?: (input: Input) => unknown;
  readonly output?: (output: Output) => unknown;
  /** Parent acceptance may produce a different value from the child's returned output. */
  readonly relationAccepted?: (output: unknown, relation: InvocationRelationIdentity) => unknown;
  /** Handling a failed child produces a distinct value without changing the child's failed return. */
  readonly relationHandled?: (output: unknown, relation: InvocationRelationIdentity) => unknown;
}
export interface InvocationRecordWriter {
  observe(fact: InvocationFact, description?: InvocationRecordDescription): undefined;
}

/** Only observation declarations may request this locally supplied writer. */
export const InvocationRecordAccess = new ResourceOffer<InvocationRecording, InvocationRecordWriter>({
  name: 'observation.call-record',
  expose: (recording, activity) =>
    Object.freeze({
      observe(fact: InvocationFact, description?: InvocationRecordDescription): undefined {
        activity.validate();
        recording.observeDescribed(fact, description);
        return undefined;
      },
    }),
});

/** Call records are produced here, not by an implicit Invocation recording path. */
export function invocationRecording<Input = unknown, Output = unknown>(description: InvocationRecordDescription<Input, Output> = {}, options: { failure?: 'isolate' | 'propagate' } = {}) {
  const input = description.input?.bind(description);
  const output = description.output?.bind(description);
  const relationAccepted = description.relationAccepted?.bind(description);
  const relationHandled = description.relationHandled?.bind(description);
  const mapped: InvocationRecordDescription = {
    ...(description.role !== undefined ? { role: description.role } : {}),
    ...(input ? { input: (value: unknown) => input(value as Input) } : {}),
    ...(output ? { output: (value: unknown) => output(value as Output) } : {}),
    ...(relationAccepted ? { relationAccepted } : {}),
    ...(relationHandled ? { relationHandled } : {}),
  };
  return defineObservation<InvocationFact, { record: InvocationRecordWriter }>(
    {
      deps: { record: InvocationRecordAccess.request() },
      observe(fact, ports) {
        return ports.record.observe(fact, mapped);
      },
    },
    options,
  );
}
