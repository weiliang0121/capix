import { TranscriptFacts, type TranscriptEvent } from '@weiliang0121/capix-transcript';
import { MemoryFacts, type MemoryEvent } from '@weiliang0121/capix-memory';
import type { ResourceFact } from '@weiliang0121/capix-resources';
import type { RecordWriter } from './construction.js';
import type { RecordChangeSource } from './source.js';
import { TranscriptRecord } from './transcript/record.js';
import { MemoryRecord } from './memory/record.js';

export function transcriptRecord(event: TranscriptEvent, source?: RecordChangeSource): TranscriptRecord {
  const change = event.change;
  return new TranscriptRecord({ transcriptId: event.transcriptId, revision: event.revision, occurredAt: event.occurredAt, ...(source ? { source } : {}) }, change.kind === 'messages-appended' ? { action: 'append', start: change.start, end: change.start + change.messages.length } : { action: 'segment', previousStart: change.previousStart, start: change.start, end: change.end });
}

export function memoryRecord(event: MemoryEvent<unknown>, source?: RecordChangeSource): MemoryRecord {
  // Metadata may contain Stable values that Records and JSON do not encode faithfully.
  // This adapter promises only the public display projection.
  return new MemoryRecord({ memoriesId: event.memoriesId, memoryId: event.change.memoryId, sequence: event.sequence, ...(source ? { source } : {}) }, { action: event.change.action, ...(event.change.reason !== undefined ? { reason: event.change.reason } : {}), result: { content: event.change.value.content } });
}

/** Optional content projection. Domain origin and the forwarding operation must agree
 * with the actual invocation; operation delivery alone does not establish authorship. */
export function recordContentFact(fact: ResourceFact, source: RecordChangeSource, writer: RecordWriter): void {
  if (fact.contextId !== source.contextId) throw new Error('Content fact forwarding context does not match record source');
  if (
    TranscriptFacts.match(fact.fact, (event) => {
      if (event.origin?.contextId !== source.contextId) throw new Error('Transcript fact origin does not match record source');
      writer.add(transcriptRecord(event, source));
    })
  )
    return;
  MemoryFacts.match(fact.fact, (event) => {
    if (event.origin?.contextId !== source.contextId) throw new Error('Memory fact origin does not match record source');
    writer.add(memoryRecord(event, source));
  });
}
