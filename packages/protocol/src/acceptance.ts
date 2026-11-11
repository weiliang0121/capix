import { stableValue, type Stable } from '@weiliang0121/capix-contracts';
import type { TranscriptUpdate } from './transcript.js';

/** Admit one fixed wire value. Sequence continuity and replacement ownership belong to the consumer. */
export function acceptTranscriptUpdate(value: unknown): Stable<TranscriptUpdate> {
  const fixed: unknown = stableValue(value);
  const update = record(fixed);
  if (update.type === 'baseline') {
    keys(update, ['type', 'snapshot']);
    const snapshot = record(update.snapshot);
    keys(snapshot, ['id', 'revision', 'start', 'end', 'starts', 'messages']);
    text(snapshot.id);
    integer(snapshot.revision);
    integer(snapshot.end);
    if (snapshot.start !== 0) fail();
    messages(snapshot.messages);
    if (snapshot.messages.length !== snapshot.end || !Array.isArray(snapshot.starts) || snapshot.starts.length === 0 || snapshot.starts[0] !== 0) fail();
    let previous = -1;
    for (const start of snapshot.starts) {
      integer(start);
      if (start <= previous || (previous >= 0 && start >= snapshot.end)) fail();
      previous = start;
    }
    const minimumRevision = snapshot.messages.length ? snapshot.starts.length : 0;
    const maximumRevision = snapshot.messages.length + snapshot.starts.length - 1;
    if (snapshot.revision < minimumRevision || snapshot.revision > maximumRevision) fail();
  } else if (update.type === 'delta') {
    keys(update, ['type', 'event']);
    const event = record(update.event);
    keys(event, ['type', 'transcriptId', 'revision', 'occurredAt', 'change'], ['origin']);
    if (event.type !== 'transcript') fail();
    text(event.transcriptId);
    integer(event.revision, 1);
    text(event.occurredAt);
    if (!Number.isFinite(Date.parse(event.occurredAt))) fail();
    if (Object.hasOwn(event, 'origin')) {
      const origin = record(event.origin);
      keys(origin, ['contextId']);
      text(origin.contextId);
    }
    const change = record(event.change);
    if (change.kind === 'messages-appended') {
      keys(change, ['kind', 'start', 'messages']);
      integer(change.start);
      messages(change.messages);
      if (change.messages.length === 0 || !Number.isSafeInteger(change.start + change.messages.length)) fail();
    } else if (change.kind === 'segment-started') {
      keys(change, ['kind', 'previousStart', 'start', 'end']);
      integer(change.previousStart);
      integer(change.start);
      integer(change.end);
      if (change.previousStart >= change.start || change.start >= change.end) fail();
    } else fail();
  } else if (update.type === 'error') {
    keys(update, ['type', 'code', 'error']);
    text(update.code);
    text(update.error);
  } else fail();
  return fixed as Stable<TranscriptUpdate>;
}

function fail(): never {
  throw new TypeError('Invalid transcript update');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (!required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) fail();
}

function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/\S/u.test(value)) fail();
}

function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || Object.is(value, -0)) fail();
}

function messages(value: unknown): asserts value is readonly { readonly role: 'user' | 'assistant'; readonly content: string }[] {
  if (!Array.isArray(value)) fail();
  for (const raw of value) {
    const message = record(raw);
    keys(message, ['role', 'content']);
    if (message.role !== 'user' && message.role !== 'assistant') fail();
    text(message.content);
  }
}
