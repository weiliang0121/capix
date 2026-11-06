import { isDeepStrictEqual } from 'node:util';
import { MemoryViewSource } from '@capix/memory';
import { TranscriptViewSource } from '@capix/transcript';
import { ResourceOffer, type ResourcesOf } from '@capix/resources';
import { Node, checkpointPoint } from '@capix/structure';
import type { ConversationViewSource } from '../../materials/view.js';
import type { ConversationMaterialInput } from '../../materials/input.js';
import type { AcceptedConversationMessage } from '../../scene.js';
import { acceptedMessageCodec } from '../../recovery/codecs.js';
import { materialInputCodec } from '../../recovery/model-codecs.js';
import { assertToolOutputBytes } from '../../tools/budget.js';

/** Select active memory values, without reading every historical message body first. */
export const ToolPreparationResource = new ResourceOffer({
  name: 'conversation.tools.preparation',
  methods: {
    prepare(source: ConversationViewSource, input: AcceptedConversationMessage): ConversationMaterialInput {
      if (source.memories.transcript !== source.transcript || input.transcriptId !== source.transcript.id || input.message.role !== 'user' || !isDeepStrictEqual(source.transcript.get(input.index), input.message)) throw new Error('Tool preparation requires its actual formally accepted input');
      const memories = new MemoryViewSource(source.memories);
      const index = source.view.indexSync({ messages: new TranscriptViewSource(source.transcript), memories });
      const keys = index.members.filter((entry) => entry.source === 'memories').map((entry) => entry.key);
      const selected = memories.read(keys, index.basis.sources.memories);
      return Object.freeze({ query: Object.freeze({ transcriptId: input.transcriptId, index: input.index, content: input.message.content }), materials: Object.freeze({ basis: index.basis, entries: Object.freeze(selected.entries.map((entry) => Object.freeze({ source: 'memories' as const, key: entry.key, value: entry.value }))) }) });
    },
  },
});
export function createToolPreparation(maxMaterialBytes: number) {
  const deps = { preparation: ToolPreparationResource.request() };
  const output = { encode: (value: ConversationMaterialInput) => materialInputCodec.encode(assertToolOutputBytes(value, maxMaterialBytes)), decode: (value: Parameters<typeof materialInputCodec.decode>[0]) => assertToolOutputBytes(materialInputCodec.decode(value), maxMaterialBytes) };
  const captured = checkpointPoint<'node', AcceptedConversationMessage, ConversationMaterialInput>()({
    name: 'captured',
    state: output,
    references: {},
    check(input, facts) {
      if (facts.input.message.role !== 'user' || input.query.transcriptId !== facts.input.transcriptId || input.query.index !== facts.input.index || input.query.content !== facts.input.message.content || input.materials.entries.some((entry) => entry.source !== 'memories')) throw new Error('Tool preparation differs from the fixed query and active memory policy');
    },
    resume: { run: (_work, input) => input },
  });
  return new Node<AcceptedConversationMessage, ConversationMaterialInput, ResourcesOf<typeof deps>>({
    name: 'prepare-tool-conversation',
    deps,
    checkpoint: { key: 'conversation.tools.prepare', version: 1, input: acceptedMessageCodec, output, points: [captured] },
    async run(work) {
      const input = await work.resources.preparation.prepare(work.input);
      assertToolOutputBytes(input, maxMaterialBytes);
      work.checkpoint?.({ point: captured, state: input, refs: {} });
      return input;
    },
  });
}
