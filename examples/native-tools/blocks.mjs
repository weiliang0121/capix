import { z } from 'zod';
import { fixed } from './value.mjs';

const text = z.strictObject({ type: z.literal('text'), text: z.string() });
const call = z.strictObject({ type: z.literal('tool_use'), id: z.string().min(1), name: z.string().min(1), input: z.record(z.string(), z.unknown()) });
const thinking = z.strictObject({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() });
const block = z.discriminatedUnion('type', [text, call, thinking]);
const output = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('text'), text: z.string() }), z.strictObject({ kind: z.literal('tool-call'), id: z.string().min(1), name: z.string().min(1), arguments: z.strictObject({ encoding: z.literal('json-value'), value: z.record(z.string(), z.unknown()) }) })]);
const partition = z.strictObject({ output: z.array(output), native: z.strictObject({ format: z.literal('ordered-block-fixture'), version: z.literal(1), source: z.literal('offline-fixture'), blocks: z.array(thinking), layout: z.array(z.strictObject({ kind: z.enum(['output', 'native']), index: z.number().int().nonnegative() })) }) });

/** A counterexample fixture only: not a Claude endpoint adapter. */
export function partitionBlocks(value) {
  const blocks = z.array(block).parse(fixed(value));
  const outputs = [];
  const native = [];
  const layout = [];
  for (const item of blocks) {
    if (item.type === 'thinking') {
      layout.push({ kind: 'native', index: native.length });
      native.push(item);
    } else {
      layout.push({ kind: 'output', index: outputs.length });
      outputs.push(item.type === 'text' ? { kind: 'text', text: item.text } : { kind: 'tool-call', id: item.id, name: item.name, arguments: { encoding: 'json-value', value: item.input } });
    }
  }
  return fixed({ output: outputs, native: { format: 'ordered-block-fixture', version: 1, source: 'offline-fixture', blocks: native, layout } });
}

export function assembleBlocks(value) {
  const accepted = partition.parse(fixed(value));
  let nextOutput = 0;
  let nextNative = 0;
  const result = accepted.native.layout.map((reference) => {
    if (reference.kind === 'native') {
      if (reference.index !== nextNative++ || reference.index >= accepted.native.blocks.length) throw new TypeError('Native layout is not an exact ordered reference');
      return accepted.native.blocks[reference.index];
    }
    if (reference.index !== nextOutput++ || reference.index >= accepted.output.length) throw new TypeError('Output layout is not an exact ordered reference');
    const item = accepted.output[reference.index];
    return item.kind === 'text' ? { type: 'text', text: item.text } : { type: 'tool_use', id: item.id, name: item.name, input: item.arguments.value };
  });
  if (nextOutput !== accepted.output.length || nextNative !== accepted.native.blocks.length) throw new TypeError('Native layout omitted stored content');
  return fixed(result);
}
