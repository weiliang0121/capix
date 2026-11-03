import { CallableRecord, CompositeRecord, InvocationBoundaryRecord, MemoryRecord, ResourceRecord, TranscriptRecord, type Recorder, type RecordingRootRecord } from '@capix/records';
import type { ConversationCallDetail, ConversationCallSummary, ConversationInspection } from '@capix/protocol';
import type { ConversationViewSource } from '../materials/view.js';

/** HTTP inspection reads real entities; it never determines admission or submission outcomes. */
export function inspectConversation(content: ConversationViewSource, recorder: Recorder, root: RecordingRootRecord, integrity: 'intact' | 'incomplete'): ConversationInspection {
  const ids = root.childIds;
  const calls: ConversationCallSummary[] = [];
  for (const id of ids.slice(-100)) {
    const call = recorder.book.get(id);
    if (!(call instanceof CallableRecord) || call.structureKind !== 'scene') continue;
    let input: ConversationCallSummary['input'];
    let answer: ConversationCallSummary['answer'];
    for (const childId of call.childIds) {
      const child = recorder.book.get(childId);
      if (!(child instanceof TranscriptRecord) || child.transcriptId !== content.transcript.id || child.value.action !== 'append') continue;
      for (let index = child.value.start; index < child.value.end; index++) {
        const message = content.transcript.get(index);
        if (message?.role === 'user' && !input) input = { transcriptId: child.transcriptId, index };
        if (message?.role === 'assistant') answer = { transcriptId: child.transcriptId, index };
      }
    }
    calls.push({ id: call.id, contextId: call.contextId, status: call.status, ...(call.name ? { name: call.name } : {}), ...(call.value.startedAt ? { startedAt: call.value.startedAt } : {}), ...(input ? { input } : {}), ...(answer ? { answer } : {}) });
  }
  return {
    transcriptId: content.transcript.id,
    memories: { id: content.memories.id, sequence: content.memories.sequence, items: content.memories.snapshot() },
    view: content.view.exportState(),
    recording: { recorderId: recorder.id, revision: recorder.revision, integrity, calls, omitted: Math.max(0, ids.length - 100) },
  };
}

/** Bound work to this selected root, without materializing every call in the recording book. */
export function inspectConversationCall(recorder: Recorder, root: RecordingRootRecord, id: string, integrity: 'intact' | 'incomplete'): ConversationCallDetail | undefined {
  const call = recorder.book.get(id);
  if (!(call instanceof CallableRecord) || call.parentId !== root.id || call.structureKind !== 'scene') return undefined;
  const calls: ConversationCallDetail['calls'][number][] = [];
  const resources: ConversationCallDetail['resources'][number][] = [];
  const transcripts: ConversationCallDetail['transcripts'][number][] = [];
  const memories: ConversationCallDetail['memories'][number][] = [];
  const boundaries: ConversationCallDetail['boundaries'][number][] = [];
  const pending = [...call.childIds].reverse();
  let count = 0;
  for (let next = pending.pop(); next !== undefined; next = count < 4096 ? pending.pop() : undefined) {
    const record = recorder.book.get(next);
    if (!record) throw new Error('Recording subtree contains a missing member');
    count++;
    if (record instanceof CallableRecord) calls.push(record.toJSON());
    else if (record instanceof ResourceRecord) resources.push(record.toJSON());
    else if (record instanceof TranscriptRecord) transcripts.push(record.toJSON());
    else if (record instanceof MemoryRecord) memories.push(record.toJSON());
    else if (record instanceof InvocationBoundaryRecord) boundaries.push(record.toJSON());
    if (record instanceof CompositeRecord) pending.push(...[...record.childIds].reverse());
  }
  return { recorderId: recorder.id, revision: recorder.revision, integrity, root: call.toJSON(), calls, resources, transcripts, memories, boundaries, truncated: pending.length > 0 };
}
