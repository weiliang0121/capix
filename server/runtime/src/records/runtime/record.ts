import type { RuntimeRecord as RuntimeData, RuntimeValue } from '@capix-observer/protocol';
import { CompositeRecord } from '../composite.js';
import { snapshotValue } from '../value/snapshot.js';

/** Establishment of a Runtime data scope, independent of individual E calls. */
export class RuntimeRecord extends CompositeRecord<RuntimeValue> implements RuntimeData {
  constructor(value: RuntimeValue) {
    super(snapshotValue(value));
    Object.freeze(this);
  }
}
