import type { MessageRef } from '../../transcript/ref.js';
import { TranscriptRangeRef } from '../../transcript/ref.js';

export interface SelectionInput {
  readonly query: MessageRef;
  readonly historyRange: TranscriptRangeRef;
}

export function selectionInput(query: MessageRef): SelectionInput {
  return Object.freeze({ query, historyRange: new TranscriptRangeRef(query.transcript, 0, query.index) });
}
