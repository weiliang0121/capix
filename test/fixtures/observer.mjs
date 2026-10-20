import { CallableContext, Transcript, TranscriptRangeRef, bindResources, InvocationWorkBinding, BoundChildren, Memories, SelectionUsage } from '@capix/server-runtime';
import { fixtureState } from './runtime.mjs';
import { resolveDeclaration } from '@capix/server-runtime/construction';
import assert from 'node:assert/strict';

import { createConversationStructure, ActiveContent, acceptConversationInput, initializeObserver, observeExecution, conversationProviders, ModelSource, ModelInteractions } from '@capix/observer-service';

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
      entities = { transcript, memories: new Memories(transcript, { observation: runtime.recording?.memory }), selectionUsage: new SelectionUsage() };
      entities.active = new ActiveContent(transcript, entities.memories);
      worlds.set(transcript, entities);
    }
    return binding({ ...source, ...entities, model, delivery: () => {} });
  };
}
export function bindChild(runtime, definition) {
  const state = fixtureState(runtime);
  const resolved = resolveDeclaration(definition, { observationProvides: runtime.recording?.provides });
  const bind = (current) => {
    const children = new BoundChildren(current.members, bind);
    const work = new InvocationWorkBinding(current.declaration, children, 'members' in current.declaration);
    const bound = {
      definition: current.definition,
      children,
      create(parent, input, options = {}) {
        return state.decorate(state.builder.create(input, { parent, kind: current.kind, ...options, requires: current.requires, supply: current.supply, refinements: current.refinements, description: current.declaration, observation: current.declaration.observation, work }));
      },
      async call(parent, input) {
        return this.create(parent, input).run();
      },
    };
    return bound;
  };
  return bind(resolved);
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
  return observeExecution(environment.driver, environment.scene, environment.recording, { messages: [input] }, { settings, signal }, publish);
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
