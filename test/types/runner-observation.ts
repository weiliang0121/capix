import { Runner, Resources, type CheckpointInstallation, type InvocationProgress, type ObservationInstallation, type RunnerObservation, type RunnerObservationEvent, type RunnerObservationReceiver } from '@capix/server-runtime';
import type { RootInvocationOptions } from '@capix/server-runtime/construction';
import { Scene } from '@capix/structure';

const runner = new Runner(new Scene<string, string>({ run: (work) => work.input }), new Resources()).build();
const observation: RunnerObservation = runner.observation;
const receiver: RunnerObservationReceiver = {
  receive(event) {
    const metadata: RunnerObservationEvent = event;
    const runnerId: string = event.runnerId;
    const entryId: string = event.entryId;
    const occurredAt: string = event.fact.occurredAt;
    // @ts-expect-error Observation consumers cannot rewrite entry ownership.
    event.entryId = 'another-entry';

    if (event.source === 'entry') {
      const sequence: number = event.fact.sequence;
      if (event.fact.kind === 'attached') {
        const contextId: string = event.fact.identity.contextId;
        void contextId;
      }
      if (event.fact.kind === 'settled') {
        const status: 'succeeded' | 'failed' | 'cancelled' = event.fact.status;
        // @ts-expect-error Entry feedback does not transport the business result.
        const result = event.fact.result;
        void [status, result];
      }
      // @ts-expect-error Entry feedback does not transport run input.
      const input = event.fact.input;
      void [sequence, input];
    }
    if (event.source === 'invocation') {
      const progress: InvocationProgress = event.fact;
      const contextId: string = event.fact.identity.contextId;
      // @ts-expect-error Passive invocation facts do not contain input bodies.
      const input = event.fact.input;
      // @ts-expect-error Passive invocation facts do not contain output bodies.
      const output = event.fact.output;
      void [progress, contextId, input, output];
    }
    if (event.source === 'resource') {
      const contextId: string = event.fact.contextId;
      const offerId: string = event.fact.offerId;
      const phase: string = event.fact.phase;
      // @ts-expect-error Passive subscribers cannot ask the producer to materialize resource bodies.
      event.fact.describe();
      void [contextId, offerId, phase];
    }
    if (event.source === 'checkpoint') {
      const activityId: string = event.fact.activityId;
      const recovering: boolean = event.fact.recovering;
      if (event.fact.kind === 'installed') {
        const point: string = event.fact.point;
        const children: number = event.fact.baseline.childCount;
        // @ts-expect-error Saved images and their business contents are not observation metadata.
        const frame = event.fact.frame;
        void [point, children, frame];
      }
      if (event.fact.kind === 'failed') {
        const code: string = event.fact.diagnostic.code;
        // @ts-expect-error The raw failure object does not cross this passive projection.
        const error = event.fact.error;
        void [code, error];
      }
      void [activityId, recovering];
    }
    void [runnerId, entryId, occurredAt, metadata];
    return undefined;
  },
};
const unsubscribe: () => void = observation.subscribe(receiver);
unsubscribe();

runner.output.subscribe({
  receive(event) {
    const entryId: string = event.entryId;
    if (event.kind === 'completed') {
      const result: string = event.result;
      void result;
    }
    void entryId;
    return undefined;
  },
});

// @ts-expect-error Observation subscriptions must consume synchronously.
runner.observation.subscribe({ receive: async () => undefined });
// @ts-expect-error The Runner owns its observation outlet.
runner.observation = runner.observation;
// @ts-expect-error Consumers cannot publish observation events.
runner.observation.publish({ source: 'entry', fact: { kind: 'settled', status: 'succeeded' } });
// @ts-expect-error Metadata subscription cannot widen the scene's input contract.
runner.run(42);
const result: Promise<string> = runner.run('question');
void result;

// The low-level entry feedback remains a set of consumers, not a second mechanism installation.
type EntryFeedback = NonNullable<RootInvocationOptions<string>['feedback']>;
declare const checkpoints: CheckpointInstallation;
declare const installation: ObservationInstallation;
const feedback: EntryFeedback = {
  invocation: {
    receive(fact) {
      const contextId: string = fact.identity.contextId;
      void contextId;
      return undefined;
    },
  },
  checkpoint: { receive: () => undefined },
};
const noCheckpointInstallation: EntryFeedback = {
  // @ts-expect-error Feedback cannot replace the fixed checkpoint installation.
  checkpoints,
};
const noStore: EntryFeedback = {
  // @ts-expect-error Feedback cannot install or replace persistence.
  store: checkpoints.store,
};
const noObservationInstallation: EntryFeedback = {
  // @ts-expect-error Feedback consumers cannot install mandatory observation policy.
  observation: installation,
};
const checkpointIsAReceiver: EntryFeedback = {
  // @ts-expect-error A checkpoint installation is not a checkpoint feedback receiver.
  checkpoint: checkpoints,
};
void [feedback, noCheckpointInstallation, noStore, noObservationInstallation, checkpointIsAReceiver];
