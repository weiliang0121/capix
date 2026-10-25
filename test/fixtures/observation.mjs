import { ResourceBindings } from './resources.mjs';
import { bindInvocationObservation, defineObservation } from '@capix/server-runtime';

/** Focused call-mechanism tests observe real facts without installing the record preset. */
export function observeCall(observe, failure = 'propagate') {
  return bindInvocationObservation({ identity: { contextId: 'unused-binding-identity', kind: 'node' }, resources: new ResourceBindings({}), declarations: [defineObservation({ deps: {}, observe }, { failure })] }, []);
}
