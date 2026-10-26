import { bindResources } from './resources.mjs';
import { CallableContext, CallableBuilder, callableConstruction } from '@capix/server-runtime';
import { Transcript, TranscriptRangeRef, TranscriptResource } from '@capix/transcript';
import { Memories, MemoryResource } from '@capix/memory';
import { MessageUsage, MessageUsageResource } from '@capix/measurement';

import { fixtureState } from './runtime.mjs';
import { resolveDeclaration } from '@capix/server-runtime/construction';
import assert from 'node:assert/strict';

import { createConversationStructure, acceptConversationInput, initializeObserver, observeExecution, ConversationTaskResource, ModelSettingsResource, ModelResource, ConversationMaterialUsageResource, ModelSource, ModelInteractions } from '@capix/observer-service';
import { ActiveView, ActiveViewResource } from '@capix/observer-content';

// Manual Context fixtures bypass host assembly; their supply is explicit and test-local.
const conversationProviders = [
  ActiveViewResource.read.provide((source) => source.active),
  ActiveViewResource.manage.provide((source) => source.active),
  ConversationTaskResource.provide((source) => ({ progress: source.taskProgress })),
  ModelSettingsResource.snapshot.provide((source) => source.settings),
  ModelSettingsResource.timeout.provide((source) => source.settings.timeoutMs),
  TranscriptResource.fixedRange.provide((source) => {
    if (!source.transcriptRange) throw new Error('Execution Transcript range is required');
    return source.transcriptRange;
  }),
  ModelResource.create.provide((source) => source.model),
  ModelResource.read.provide((source) => source.model),
  MemoryResource.snapshot.provide((source) => source.memorySnapshot ?? source.memories),
  MemoryResource.apply.provide((source) => source.memories),
  TranscriptResource.append.provide((source) => ({ transcript: source.transcript, progress: source.messageProgress })),
  TranscriptResource.segmentation.provide((source) => source.transcript),
  ConversationMaterialUsageResource.provide((source) => source),
  MessageUsageResource.record.provide((source) => source.messageUsage),
];

const transcripts = new WeakMap();
export const transcriptFor = (input) => transcripts.get(input);
const sources = new WeakMap();
export function captureSource(options) {
  return Object.freeze({ settings: Object.freeze({ ...options.settings }), ...(options.transcript ? { transcriptRange: new TranscriptRangeRef(options.transcript, options.transcript.activeStart, options.transcript.length) } : {}) });
}
export function contextWithSource(input, options, parent) {
  const source = captureSource(options);
  const context = new CallableContext(input, 'group', { signal: parent?.signal ?? options.signal }, options.resourceBinding?.(source));
  sources.set(context, source);
  return context;
}
export function resourceBindingFor(runtime, provider, provided) {
  const model = new ModelInteractions(new ModelSource(provider));
  const supply = resolveDeclaration(createConversationStructure().scene).members[0].supply;
  const binding = bindResources(supply, conversationProviders);
  const worlds = new WeakMap();
  return (source) => {
    const transcript = source.transcriptRange?.transcript ?? new Transcript();
    let entities = provided ?? worlds.get(transcript);
    if (!entities) {
      entities = { transcript, memories: new Memories(transcript, { observation: runtime.recording?.memory }), messageUsage: new MessageUsage() };
      entities.active = new ActiveView(transcript, entities.memories);
      worlds.set(transcript, entities);
    }
    return binding({ ...source, ...entities, model, delivery: () => {} });
  };
}
export function bindChild(runtime, definition) {
  const state = fixtureState(runtime);
  // This low-level fixture supplies resources through its manually constructed parent calls.
  // Build real structures first; root provider resolution must never replace that supplied world.
  const resolved = resolveDeclaration(definition, { observationProvides: runtime.recording?.provides });
  const offers = [...new Set(Object.values(resolved.supply).map((request) => request.offer))];
  const built = new CallableBuilder(state.capabilities).build(definition, {
    providers: offers.map((offer) => ({
      offer,
      readMaterial() {
        throw new Error('Fixture resources must come from the explicit parent');
      },
    })),
    source: { capture: () => null },
  });
  const { binding, invocations, calls } = callableConstruction(built);
  state.builder = invocations;
  state.construction = calls.begin({});
  return {
    definition,
    create(parent, input, options = {}) {
      return state.decorate(invocations.create(input, { parent, kind: definition.kind, ...options, construction: state.construction, deps: binding.deps, supply: binding.supply, refinements: binding.refinements, description: binding.declaration, observation: binding.observations, work: binding.work }));
    },
    async call(parent, input) {
      return this.create(parent, input).run();
    },
  };
}
// Construction metadata is captured only by this test fixture, not exposed by a work Context.
export const sourceFor = (context) => sources.get(context);
export const contextFor = (input, settings = {}) => contextWithSource(input, { settings, transcript: transcriptFor(input) });

export function createInput({ content, history }) {
  const transcript = new Transcript(history);
  const input = acceptConversationInput(transcript, { messages: [{ role: 'user', content }] });
  transcripts.set(input, transcript);
  return input;
}

export function observeFixture(input, settings, provider, publish, signal) {
  const environment = initializeObserver(provider, transcriptFor(input).snapshot().slice(0, -1));
  transcripts.set(input, environment.transcript);
  return observeExecution(environment.runner, environment.records.installation, { messages: [input] }, { settings, signal }, publish);
}

export function resourceFact(snapshot, access) {
  const owners = new Set(snapshot.calls.map((call) => call.id));
  const facts = snapshot.resources.filter((fact) => owners.has(fact.parentId) && fact.access === access && fact.phase === 'available');
  const first = facts[0];
  for (const fact of facts) {
    assert.equal(fact.supplyId, first.supplyId, 'fixture expects one observed supply');
    assert.deepEqual(fact.value, first.value, 'one captured supply must retain its value');
  }
  return first?.value;
}
