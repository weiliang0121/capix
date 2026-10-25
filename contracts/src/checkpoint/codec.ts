/** Persistent business values; no invocation image or persistence implementation is required. */
export type CheckpointValue = null | boolean | number | string | readonly CheckpointValue[] | { readonly [key: string]: CheckpointValue };

/** Encoding is explicit; decoders must reject incompatible saved business values. */
export interface CheckpointCodec<Value> {
  encode(value: Value): CheckpointValue;
  decode(value: CheckpointValue): Value;
}

export interface CheckpointContract {
  readonly key: string;
  readonly version: number;
}
