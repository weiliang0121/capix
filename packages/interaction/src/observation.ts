import { ProgressChannel, type ProgressReceiver } from '@weiliang0121/capix-changes';
import type { InteractionProgressFact } from './progress/types.js';

/** One registration shares a passive consumer; recursive new exchanges cannot recurse forever. */
export function progressObservation(receiver?: ProgressReceiver<InteractionProgressFact>): ProgressReceiver<InteractionProgressFact> | undefined {
  if (!receiver) return undefined;
  const receive = receiver.receive.bind(receiver);
  let delivering = false;
  const channel = new ProgressChannel<InteractionProgressFact>({
    receive(fact) {
      if (delivering) throw new TypeError('Interaction progress observation cannot recursively deliver facts');
      delivering = true;
      try {
        return receive(fact);
      } finally {
        delivering = false;
      }
    },
    failed: receiver.failed?.bind(receiver),
  });
  return Object.freeze({
    receive: (fact: Readonly<InteractionProgressFact>): undefined => {
      channel.publish(fact);
    },
  });
}
