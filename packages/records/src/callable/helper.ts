import type { ExecutionRecordSnapshot } from '../data/index.js';
import type { Recorder } from '../recorder.js';
import { InvocationBoundaryRecord } from '../invocation/boundary/record.js';
import { MemoryRecord } from '../memory/record.js';
import { ResourceRecord } from '../resource/record.js';
import { TranscriptRecord } from '../transcript/record.js';
import { CallableRecord } from './record.js';

/** The caller chooses a subtree; a structural kind does not imply a business task. */
export class CallableRecordHelper {
  static snapshot(recorder: Recorder, id: string): ExecutionRecordSnapshot {
    const selected = recorder.book.get(id);
    if (!(selected instanceof CallableRecord)) throw new Error('Callable record does not exist');
    const records = [selected, ...recorder.tree.descendants(id)];
    let root = selected;
    const ancestry: CallableRecord[] = [];
    const visited = new Set([selected.id]);
    let parent = root.parentId ? recorder.book.get(root.parentId) : undefined;
    while (parent instanceof CallableRecord) {
      if (visited.has(parent.id) || !parent.childIds.includes(root.id)) throw new Error('Inconsistent callable record ancestry');
      visited.add(parent.id);
      ancestry.unshift(parent);
      root = parent;
      parent = root.parentId ? recorder.book.get(root.parentId) : undefined;
    }
    const ancestorDetails = ancestry.flatMap((ancestor) => recorder.tree.children(ancestor.id));
    const boundaries = [...ancestorDetails.filter((record): record is InvocationBoundaryRecord => record instanceof InvocationBoundaryRecord), ...records.filter((record): record is InvocationBoundaryRecord => record instanceof InvocationBoundaryRecord)];
    boundaries.sort((left, right) => (left.scopeId === right.scopeId ? left.sequence - right.sequence : Date.parse(left.occurredAt) - Date.parse(right.occurredAt)));
    return {
      execution: selected.toJSON(),
      calls: records.filter((record): record is CallableRecord => record instanceof CallableRecord).map((record) => record.toJSON()),
      ...(root === selected ? {} : { rootCall: root.toJSON() }),
      ...(ancestry.length > 1 ? { ancestors: ancestry.slice(1).map((record) => record.toJSON()) } : {}),
      boundaries: boundaries.map((record) => record.toJSON()),
      resources: [...ancestorDetails, ...records].filter((record): record is ResourceRecord => record instanceof ResourceRecord).map((record) => record.toJSON()),
      transcripts: records.filter((record): record is TranscriptRecord => record instanceof TranscriptRecord).map((record) => record.toJSON()),
      memories: records.filter((record): record is MemoryRecord => record instanceof MemoryRecord).map((record) => record.toJSON()),
    };
  }
}
