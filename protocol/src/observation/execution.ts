import type { SelectionObservation } from './selection.js';
import type { OperationRecord } from '../records.js';

/** A QA is a view of one execution, not another stored runtime entity. */
export interface ExecutionObservation extends Omit<SelectionObservation, 'executions'> {
  executions: (SelectionObservation['executions'][number] & {
    response?: { index?: number };
    memoryStatus?: OperationRecord['status'];
  })[];
}
