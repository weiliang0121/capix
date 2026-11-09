import type { CheckpointValue } from '@weiliang0121/capix-contracts';

export interface CheckpointValueMetrics {
  readonly bytes: number;
  readonly nodes: number;
  readonly depth: number;
}

const format = 'capix.checkpoint.value@1';
export const checkpointEncodingOverhead = Buffer.byteLength(JSON.stringify({ format, value: null })) - 4;

/** V6 escapes value strings beginning with ~, reserving ~0 for negative zero. */
export function encodeCheckpointData(value: unknown): string {
  return JSON.stringify({ format, value: encode(value) });
}

export function decodeCheckpointData(body: string): unknown {
  const value = JSON.parse(body) as { format?: unknown; value?: unknown };
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== format || !Object.hasOwn(value, 'value') || Object.keys(value).length !== 2) throw new Error('Invalid checkpoint value encoding');
  return decode(value.value);
}

/** The caller has already fixed the pure value. References may substitute verified subtree metrics. */
export function checkpointMetrics(value: unknown, reference?: (value: object) => CheckpointValueMetrics | undefined): CheckpointValueMetrics {
  if (value !== null && typeof value === 'object') {
    const linked = reference?.(value);
    if (linked) return linked;
    let bytes = 2;
    let nodes = 1;
    let depth = 0;
    const values = Array.isArray(value) ? value.map((entry) => [undefined, entry] as const) : Object.entries(value);
    for (let i = 0; i < values.length; i++) {
      const [key, entry] = values[i]!;
      const measured = checkpointMetrics(entry, reference);
      bytes += measured.bytes + (i ? 1 : 0) + (key === undefined ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1);
      nodes += measured.nodes;
      depth = Math.max(depth, measured.depth + 1);
    }
    return { bytes, nodes, depth };
  }
  return { bytes: Buffer.byteLength(JSON.stringify(encode(value))), nodes: 1, depth: 0 };
}

function encode(value: unknown): unknown {
  if (typeof value === 'number' && Object.is(value, -0)) return '~0';
  if (typeof value === 'string') return value.startsWith('~') ? `~${value}` : value;
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]));
  return value;
}

function decode(value: unknown): CheckpointValue {
  if (typeof value === 'string') {
    if (value === '~0') return -0;
    if (value.startsWith('~~')) return value.slice(1);
    if (value.startsWith('~')) throw new Error('Invalid checkpoint string escape');
    return value;
  }
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
  return value as CheckpointValue;
}
