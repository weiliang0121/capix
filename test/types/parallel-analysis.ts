import { modelReplyText } from '@capix/model-provider';
import { CompletionResource, ConversationViewResource, createConversationScene, createMaterialPreparation, type ConversationMaterialInput, type ConversationMaterialSources } from '@capix/conversation-service';
import { Memories } from '@capix/memory';
import type { ModelProvider } from '@capix/model-provider';
import { Resource, type ResourcesOf } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Group, Node } from '@capix/structure';
import { Transcript, TranscriptResource } from '@capix/transcript';
import { View } from '@capix/view';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

interface SelectedMaterial {
  readonly transcriptId: string;
  readonly index: number;
  readonly content: string;
}

interface AnalysisInput {
  readonly query: ConversationMaterialInput['query'];
  readonly material: SelectedMaterial;
}

interface AvailableAnalysis {
  readonly status: 'available';
  readonly material: SelectedMaterial;
  readonly analysis: string;
}

interface UnavailableAnalysis {
  readonly status: 'unavailable';
  readonly material: SelectedMaterial;
  readonly reason: string;
}

interface MergeInput {
  readonly query: ConversationMaterialInput['query'];
  readonly primary: AvailableAnalysis;
  readonly secondary: AvailableAnalysis | UnavailableAnalysis;
}

class AnalysisUnavailable extends Error {}

function selectMaterial(input: ConversationMaterialInput, index: number): SelectedMaterial {
  const source = input.materials.basis.sources.messages;
  const entry = input.materials.entries.find((entry) => entry.source === 'messages' && entry.key === index);
  if (source.id !== input.query.transcriptId || index >= input.query.index || !entry) throw new Error('Selected prior message is unavailable');
  return Object.freeze({ transcriptId: source.id, index, content: entry.value.content });
}

function accepted(material: SelectedMaterial, analysis: string) {
  return Object.freeze({ status: 'available', material, analysis });
}

function createAnalysis(name: string) {
  const deps = { model: CompletionResource.request() };
  return new Node<AnalysisInput, string, ResourcesOf<typeof deps>, string>({
    name,
    deps,
    async run(work) {
      const reply = await work.resources.model.complete({ messages: [{ role: 'user', content: JSON.stringify(work.input) }], stream: true }, { delta: (value) => work.output.emit(value) });
      if (reply.termination.reason !== 'stop' || !modelReplyText(reply).trim()) throw new Error('Incomplete analysis');
      return modelReplyText(reply);
    },
  });
}

const primary = createAnalysis('primary');
const secondary = createAnalysis('secondary');
const merge = new Node<MergeInput, string, {}, string>({
  run(work) {
    const first: string = work.input.primary.analysis;
    // @ts-expect-error The secondary result must be narrowed before reading an analysis.
    const lostFailure: AvailableAnalysis = work.input.secondary;
    // @ts-expect-error A handled failure has no analysis text.
    work.input.secondary.analysis;
    const second = work.input.secondary.status === 'available' ? work.input.secondary.analysis : work.input.secondary.reason;
    const result = `${work.input.query.content}: ${first}; ${second}`;
    work.output.emit(result);
    void lostFailure;
    return result;
  },
});

// add() retains each named child's input, result and delta. It does not grant its deps.
const answer = new Group<ConversationMaterialInput, string, {}, string>().add({ primary, secondary, merge });
answer.run = async (work) => {
  const first = selectMaterial(work.input, 0);
  const second = selectMaterial(work.input, 2);
  const query = work.input.query;
  const results = await Promise.all([
    work.children.primary.invoke({ query, material: first }, { result: { succeeded: (value) => accepted(first, value) } }),
    work.children.secondary.invoke(
      { query, material: second },
      {
        result: {
          succeeded: (value) => accepted(second, value),
          failed(error) {
            const failure: unknown = error;
            if (!(failure instanceof AnalysisUnavailable)) throw failure;
            return Object.freeze({ status: 'unavailable', material: second, reason: failure.message });
          },
        },
      },
    ),
  ]);
  // These checks exercise inferred types, without annotating Promise.all or its callbacks.
  type ParallelTuple = Assert<Equal<typeof results, [AvailableAnalysis, AvailableAnalysis | UnavailableAnalysis]>>;
  const [primaryResult, secondaryResult] = results;
  type PrimaryResult = Assert<Equal<typeof primaryResult, AvailableAnalysis>>;
  type SecondaryResult = Assert<Equal<typeof secondaryResult, AvailableAnalysis | UnavailableAnalysis>>;
  const mergeInput = { query, primary: primaryResult, secondary: secondaryResult } satisfies MergeInput;

  // @ts-expect-error Child input is the selected query/material pair, not all captured material.
  work.children.primary.invoke(work.input);
  // @ts-expect-error Both branches retain the same concrete material contract.
  work.children.secondary.invoke({ query, material: 'second' });
  // @ts-expect-error Available branches require their accepted wrapper, not raw child text.
  work.children.merge.invoke({ query, primary: 'analysis', secondary: secondaryResult });
  // @ts-expect-error Promise.all positions cannot be swapped: primary cannot be unavailable.
  work.children.merge.invoke({ query, primary: secondaryResult, secondary: primaryResult });
  // @ts-expect-error Secondary failure reception remains in the inferred tuple.
  const allSucceeded: [AvailableAnalysis, AvailableAnalysis] = results;
  // @ts-expect-error Parent deps do not inherit the model capability requested by its children.
  work.resources.model.complete({ messages: [] });
  // @ts-expect-error Child calls expose actions, not the child's resource window.
  work.children.primary.resources.model;
  // @ts-expect-error The parent emits text preview chunks.
  work.output.emit(42);
  // @ts-expect-error A text-delta child cannot be consumed as numeric chunks.
  work.children.merge.invoke(mergeInput, { delta: (value: number) => void value });
  void allSucceeded;
  // Analysis previews remain local. Only the merge's text delta is forwarded.
  return work.children.merge.invoke(mergeInput, {
    delta(value) {
      const text: string = value;
      // @ts-expect-error A merger's text delta is not a number.
      const numeric: number = value;
      work.output.emit(text);
      void numeric;
    },
  });
};

const transcript = new Transcript([
  { role: 'user', content: 'First material' },
  { role: 'assistant', content: 'Received' },
  { role: 'user', content: 'Second material' },
]);
const memories = new Memories(transcript);
const view = new View<ConversationMaterialSources>({
  revision: 0,
  sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } },
  members: [
    { source: 'messages', key: 0 },
    { source: 'messages', key: 2 },
  ],
});
const model: ModelProvider = {
  async complete(_request, controls) {
    controls?.emit?.('local preview');
    return { id: 'offline', model: 'fixture', formatVersion: 1, output: [{ kind: 'text', text: 'analysis' }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null };
  },
};
const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(new Resource({ transcript, memories, view }), ConversationViewResource.read).register(new Resource(model), CompletionResource);
const scene = createConversationScene(answer, createMaterialPreparation());
const runner = new Runner(scene, resources).build();
const response: Promise<string> = runner.run('Compare the two materials');
// @ts-expect-error Host input is text; captured business input is prepared inside the Scene.
runner.run({ query: 'Compare', materials: [] });
runner.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') {
      const text: string = event.delta;
      // @ts-expect-error The Group and Scene retain a string delta through Runner.
      const numeric: number = event.delta;
      void [text, numeric];
    }
    if (event.kind === 'completed') {
      const text: string = event.result;
      void text;
    }
  },
});
void response;
