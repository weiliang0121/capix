import { defineObservation } from '@capix/server-runtime';
import { RequestModel } from '@capix/observer-service/conversation';

/** Host selection of a real model-request structure; no consumer is stored on the business node. */
export function observeModelPending(callback, options = {}) {
  const declaration = defineObservation(
    {
      deps: {},
      observe(fact) {
        if (fact.kind === 'relation' && fact.change.kind === 'returned' && fact.change.result.status === 'succeeded' && fact.change.result.output.kind === 'pending') callback(fact);
      },
    },
    options,
  );
  return { declarations: (structure) => (structure instanceof RequestModel ? [declaration] : []), bindInvocation: () => ({ observe() {} }) };
}
