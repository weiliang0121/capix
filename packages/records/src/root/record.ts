import type { RecordingRootRecord as RecordingRootData, RecordingRootValue } from '@weiliang0121/capix-protocol';
import { CompositeRecord } from '../composite.js';
import { snapshotValue } from '../value/snapshot.js';

/** Root of one recording installation, independent of bound runtime and call identities. */
export class RecordingRootRecord extends CompositeRecord<RecordingRootValue> implements RecordingRootData {
  /** Preserve the existing serialized discriminant; it does not identify a BoundRuntime. */
  override readonly kind = 'runtime' as const;
  constructor(value: RecordingRootValue) {
    super(snapshotValue(value));
    Object.freeze(this);
  }
}
