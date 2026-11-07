import { createHash } from 'node:crypto';
import { encodeCheckpointData, decodeCheckpointData } from './encoding.js';
import { cloneCheckpointValue, CHECKPOINT_MAX_BYTES } from './value.js';

const format = 'capix.checkpoint.record@1';
type RecordKind = 'head' | 'child' | 'value' | 'selection' | 'occurrence';

/** Small metadata has its own checksum; large value bodies are separately authenticated. */
export function encodeCheckpointRecord(kind: RecordKind, value: unknown): string {
  const body = encodeCheckpointData(value);
  return JSON.stringify({ format, kind, body, digest: digest(body) });
}

export function isCheckpointRecord(body: string): boolean {
  if (Buffer.byteLength(body) > CHECKPOINT_MAX_BYTES) throw new Error('Checkpoint metadata exceeds byte limit');
  // The canonical envelope can be identified without parsing its body.
  return body.startsWith(`{"format":"${format}",`);
}

export function decodeCheckpointRecord<T>(kind: RecordKind, body: string): T {
  if (Buffer.byteLength(body) > CHECKPOINT_MAX_BYTES) throw new Error('Checkpoint metadata exceeds byte limit');
  const record = JSON.parse(body) as { format?: unknown; kind?: unknown; body?: unknown; digest?: unknown };
  if (!record || Object.keys(record).sort().join() !== 'body,digest,format,kind' || record.format !== format || record.kind !== kind || typeof record.body !== 'string' || record.digest !== digest(record.body)) throw new Error('Checkpoint metadata checksum or kind differs');
  return cloneCheckpointValue(decodeCheckpointData(record.body)) as unknown as T;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
