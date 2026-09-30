import type { InvocationEvent } from '@capix-observer/protocol';
import type { ChangeCapture } from '../changes/capture.js';
import type { InvocationRecordHelper } from '../records/invocation/helper.js';

/** Stable capabilities supplied at assembly, never threaded through business call arguments. */
export interface InvocationCapabilities {
  readonly recording?: InvocationRecordHelper;
  readonly changes?: ChangeCapture<InvocationEvent>;
}
