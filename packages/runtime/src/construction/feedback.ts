import type { CheckpointInstallation, CheckpointFact, InvocationFact, ResourceObservation, BusinessObservation } from '@weiliang0121/capix-invocation';
import { ProgressChannel, type ProgressReceiver } from '@weiliang0121/capix-changes';
import type { ObservationInstallation } from '../binding/observation.js';

/** Passive receivers cannot replace installed stores, required observations or resource supply. */
export interface CallableFeedback {
  readonly invocation?: ProgressReceiver<InvocationFact>;
  readonly resource?: ProgressReceiver<ResourceObservation>;
  readonly business?: ProgressReceiver<BusinessObservation>;
  readonly checkpoint?: ProgressReceiver<CheckpointFact>;
}

/** One entry's fixed receiver identity, reused when binding its descendant observers. */
export interface CallableFeedbackBinding {
  readonly observation: ObservationInstallation;
  readonly checkpoint?: ProgressReceiver<CheckpointFact>;
}

export function bindCallableFeedback(feedback: CallableFeedback): CallableFeedbackBinding {
  const invocation = fixedReceiver(feedback.invocation);
  const resource = fixedReceiver(feedback.resource);
  const business = fixedReceiver(feedback.business);
  const checkpoint = fixedReceiver(feedback.checkpoint);
  return Object.freeze({
    checkpoint,
    observation: Object.freeze({
      bindInvocation: () => {
        const calls = invocation ? new ProgressChannel(invocation) : undefined;
        const resources = resource ? new ProgressChannel(resource) : undefined;
        const annotations = business ? new ProgressChannel(business) : undefined;
        return {
          observe: (fact: InvocationFact) => calls?.publish(fact),
          resource: (fact: ResourceObservation) => resources?.publish(fact),
          business: (fact: BusinessObservation) => annotations?.publish(fact),
        };
      },
    }),
  });
}

/** Extra consumption is attached to the fixed installation; it cannot install persistence. */
export function checkpointFeedback(installation: CheckpointInstallation | undefined, feedback?: ProgressReceiver<CheckpointFact>): CheckpointInstallation | undefined {
  if (!installation || !feedback) return installation;
  const additional = new ProgressChannel(feedback);
  const installed = installation.feedback ? new ProgressChannel(installation.feedback) : undefined;
  return Object.freeze({
    ...installation,
    feedback: Object.freeze({
      receive(fact: CheckpointFact): undefined {
        additional.publish(fact);
        installed?.publish(fact);
      },
    }),
  });
}

function fixedReceiver<Fact>(receiver?: ProgressReceiver<Fact>): ProgressReceiver<Fact> | undefined {
  return receiver ? Object.freeze({ receive: receiver.receive.bind(receiver), failed: receiver.failed?.bind(receiver) }) : undefined;
}
