import assert from 'node:assert/strict';
import { ModelExchanges, ModelExchangeResource } from '@weiliang0121/capix-model-exchanges';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { Resource } from '@weiliang0121/capix-resources';
import { Scene, Resources, Runner, checkpointPoint, childReference } from '@weiliang0121/capix-runtime';
import { Interactions } from '@weiliang0121/capix-interaction';
import { Tool, ToolModelResource } from '@weiliang0121/capix-tool';
import { codec, contract, member } from './fixture.mjs';

export const MiB = 1024 * 1024;
export const interactionLimits = { requestTextUnits: 64 * MiB, replyTextUnits: 2 * MiB };
export const durable = (value) => JSON.parse(JSON.stringify(value));

// This uses the production provider encoder and decoder with an entirely offline HTTP transport.
export function capacityHost({ states = new Map(), rounds = 3, requestLimit = 8 * MiB, forbidSend = false, retained = 128 } = {}) {
  const sent = [];
  const wire = [];
  const provider = new ChatCompletionsProvider({
    endpoint: 'https://capacity.fixture.test/chat/completions',
    apiKey: 'offline-fixture',
    model: 'offline-capacity',
    maxRequestBytes: requestLimit,
    maxWireRequestBytes: requestLimit,
    fetch: async (_url, init) => {
      if (forbidSend) assert.fail('cold recovery resent a completed provider request');
      const body = JSON.parse(init.body);
      const turn = body.messages.filter((message) => message.role === 'tool').length;
      wire.push({ bytes: Buffer.byteLength(init.body), turn });
      const message = turn < rounds ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${turn}`, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ key: String(turn) }) } }] } : { role: 'assistant', content: 'finished' };
      return Response.json({ id: `reply-${turn}`, model: 'offline-capacity', choices: [{ index: 0, message, finish_reason: turn < rounds ? 'tool_calls' : 'stop' }], usage: null });
    },
  });
  const interactions = new Interactions({ retained }).register(contract, {
    limits: interactionLimits,
    send(request) {
      sent.push({ bytes: Buffer.byteLength(JSON.stringify(request)), turn: request.exchanges.length });
      return provider.complete(request);
    },
    persistence: {
      create(state) {
        states.set(state.id, durable(state));
      },
      commit({ expectedRevision, state }) {
        assert.equal(states.get(state.id).revision, expectedRevision);
        states.set(state.id, durable(state));
      },
      read: (id) => states.get(id),
    },
  });
  return { provider, interactions, states, sent, wire };
}

export function capacityAssembly(host, { checkpoint = false, store, entity = new ModelExchanges(), effects = [], text = 'x'.repeat(900 * 1024), requestLimit = 8 * MiB, feedbackLimit = MiB, recoveryLimits = interactionLimits, compactOutput = false } = {}) {
  const lookup = member(
    'lookup',
    (value) => {
      effects.push(value.key);
      return compactOutput ? { contentId: 'capacity-fixture', textUnits: text.length } : { text };
    },
    checkpoint,
  );
  // The member CP keeps only a small descriptor. Its pure mapping reconstructs feedback
  // from fixed fixture parameters, including during cold authentication. This does not
  // claim that arbitrary large original tool outputs fit the unchanged 8 MiB CP graph.
  if (compactOutput)
    lookup.result.succeeded = (value) => {
      assert.equal(value.contentId, 'capacity-fixture');
      assert.equal(value.textUnits, text.length);
      return { status: 'ok', content: [{ kind: 'text', text }] };
    };
  const tool = new Tool({
    policyVersion: compactOutput ? 'capacity-large.compact.v1' : 'capacity-large.v1',
    checkpoint,
    maxModelCalls: 64,
    budgets: { maxFeedbackBytes: feedbackLimit, maxRequestBytes: requestLimit, maxWireRequestBytes: requestLimit, maxCollectionBytes: 128 * MiB },
    tools: { lookup },
  });
  const waiting = checkpointPoint()({ name: 'waiting', state: codec, references: { tool: childReference(tool) }, resume: { uses: [tool], run: (work, _state, refs) => work.children.resume(refs.tool).invoke() } });
  const scene = new Scene({ ...(checkpoint ? { checkpoint: { key: 'capacity-large.scene', version: 1, input: codec, output: codec, points: [waiting] } } : {}) }).add({ tool });
  scene.run = (work) => {
    const child = work.children.create(tool, work.input);
    if (checkpoint) work.checkpoint({ point: waiting, state: null, refs: { tool: child.ref } });
    return child.invoke();
  };
  const source = { exchanges: entity, channel: host.interactions.bind(contract), inspection: host.provider, recovery: { read: (id) => host.states.get(id), interactionLimits: recoveryLimits } };
  const resources = new Resources().register(new Resource(entity), ModelExchangeResource).register(new Resource(source), ToolModelResource);
  return { entity, runner: new Runner(scene, resources, store ? { checkpoints: { store } } : {}).build() };
}

export async function closeCapacityHost(host) {
  await host.interactions.settled();
  host.interactions.close();
}
