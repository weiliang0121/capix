import { bindCallObservation, defineObservation, ResourceBindings } from '@capix-observer/runtime';

/** Focused call-mechanism tests observe real facts without installing the record preset. */
export function observeCall(observe, failure = 'propagate') {
  return bindCallObservation({ identity: { contextId: 'unused-binding-identity', level: 'attempt' }, resources: new ResourceBindings({}), declarations: [defineObservation({ requires: {}, observe }, { failure })] }, []);
}
