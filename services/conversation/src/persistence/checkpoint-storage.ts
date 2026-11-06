import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { CHECKPOINT_MAX_BYTES, cloneCheckpointImage, cloneCheckpointDelivery, type CheckpointImage, type CheckpointDelivery } from '@capix/checkpoint';
import { z } from 'zod';

// This is a SQLite representation, not a new Checkpoint Frame or recovery contract.
const payloadSchema = z.strictObject({ encoding: z.literal('br'), jsonBytes: z.number().int().positive().max(CHECKPOINT_MAX_BYTES), data: z.string() });
const maxStoredBytes = Math.ceil((CHECKPOINT_MAX_BYTES + 1024) / 3) * 4 + 1024;

/** Storage encoding also preserves opaque historical formats during SQL migration. */
export function encodeCheckpointStorage(value: unknown): string {
  return JSON.stringify(encode(value));
}

export function decodeCheckpointImage(body: string): CheckpointImage {
  return cloneCheckpointImage(decodeCheckpointStorage(body));
}

export function decodeCheckpointDelivery(body: string): CheckpointDelivery {
  return cloneCheckpointDelivery(decodeCheckpointStorage(body));
}

/** Migration validates storage and identity without certifying an old Frame as recoverable. */
export function decodeCheckpointStorage(body: string): unknown {
  return decode(payloadSchema.parse(parseStored(body)));
}

function encode(value: unknown): z.infer<typeof payloadSchema> {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  if (json.byteLength > CHECKPOINT_MAX_BYTES) throw new Error('Persisted checkpoint exceeds its byte limit');
  const compressed = brotliCompressSync(json, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  return { encoding: 'br', jsonBytes: json.byteLength, data: compressed.toString('base64') };
}

function parseStored(body: string): unknown {
  if (Buffer.byteLength(body, 'utf8') > maxStoredBytes) throw new Error('Persisted checkpoint storage exceeds its byte limit');
  return JSON.parse(body);
}

function decode(payload: z.infer<typeof payloadSchema>): unknown {
  if (!payload.data.length || payload.data.length % 4 !== 0) throw new Error('Persisted checkpoint has invalid base64 data');
  const compressed = Buffer.from(payload.data, 'base64');
  if (compressed.byteLength > CHECKPOINT_MAX_BYTES + 1024 || compressed.toString('base64') !== payload.data) throw new Error('Persisted checkpoint has invalid compressed data');
  const json = brotliDecompressSync(compressed, { maxOutputLength: payload.jsonBytes });
  if (json.byteLength !== payload.jsonBytes) throw new Error('Persisted checkpoint byte length differs from its storage metadata');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
}
