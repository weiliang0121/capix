import assert from 'node:assert/strict';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { ModelExchanges, ModelExchangeResource } from '@weiliang0121/capix-model-exchanges';
import { requireModelRequest, requireModelReply } from '@weiliang0121/capix-model-provider';
import { Resource } from '@weiliang0121/capix-resources';
import { Scene, Node, Resources, Runner, Interactions, checkpointPoint, childReference } from '@weiliang0121/capix-runtime';
import { Tool, ToolModelResource } from '@weiliang0121/capix-tool';
import { z } from 'zod';

export const codec = { encode: (value) => value, decode: (value) => value };
export const contract = { key: 'capix.tool.test.model.v1', request: requireModelRequest, reply: requireModelReply };
export const input = { request: { messages: [{ role: 'user', content: 'offline test' }] } };
export const result = (text) => ({ status: 'ok', content: [{ kind: 'text', text }] });
export const call = (id, name, args) => ({ kind: 'tool-call', id, name, arguments: { encoding: 'json-text', text: typeof args === 'string' ? args : JSON.stringify(args) } });
export const reply = (id, output) => ({ formatVersion: 1, id, model: 'offline', output, termination: { kind: 'completed', reason: output.some((item) => item.kind === 'tool-call') ? 'tool_calls' : 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } });
export const final = reply('final', [{ kind: 'text', text: 'finished' }]);
export function member(name, run, checkpoint = false) {
  const completed = checkpointPoint()({ name: 'completed', state: codec, references: {}, resume: { run: (_work, state) => state } });
  const node = new Node({
    ...(checkpoint ? { checkpoint: { key: `tool.test.${name}`, version: 1, input: codec, output: codec, points: [completed] } } : {}),
    async run(work) {
      const output = await run(work.input, work);
      if (checkpoint) work.checkpoint({ point: completed, state: output });
      return output;
    },
  });
  return { node, description: `Read ${name}`, input: z.strictObject({ key: z.string() }), result: { succeeded: (value) => result(value.text) } };
}
export function host(send, states = new Map()) {
  const sent = [];
  const interactions = new Interactions().register(contract, {
    send(request) {
      sent.push(structuredClone(request));
      return send(request);
    },
    persistence: {
      create(state) {
        states.set(state.id, structuredClone(state));
      },
      commit({ expectedRevision, state }) {
        assert.equal(states.get(state.id).revision, expectedRevision);
        states.set(state.id, structuredClone(state));
      },
      read: (id) => states.get(id),
    },
  });
  return { interactions, sent, states };
}
export function journal(onSave = () => {}) {
  const memory = new MemoryCheckpointStore();
  const saves = [];
  let root;
  return {
    saves,
    get contextId() {
      return root;
    },
    store: {
      read: (id) => memory.read(id),
      save(commit, revision) {
        const receipt = memory.save(commit, revision);
        root ??= receipt.contextId;
        saves.push({ commit: structuredClone(commit), revision });
        onSave(commit, saves.length);
        return receipt;
      },
      finish: (...args) => memory.finish(...args),
    },
    replay(count = saves.length) {
      const fresh = new MemoryCheckpointStore();
      for (const { commit, revision } of saves.slice(0, count)) fresh.save(commit, revision);
      return fresh;
    },
  };
}
export function assembly(configuration, modelHost, { entity = new ModelExchanges(), store, recovery = true, inspection } = {}) {
  const tool = new Tool(configuration);
  const waiting = checkpointPoint()({ name: 'waiting', state: codec, references: { tool: childReference(tool) }, resume: { uses: [tool], run: (work, _state, refs) => work.children.resume(refs.tool).invoke() } });
  const scene = new Scene({ ...(configuration.checkpoint ? { checkpoint: { key: 'tool.test.scene', version: 1, input: codec, output: codec, points: [waiting] } } : {}) }).add({ tool });
  scene.run = (work) => {
    const child = work.children.create(tool, work.input);
    if (configuration.checkpoint) work.checkpoint({ point: waiting, state: null, refs: { tool: child.ref } });
    return child.invoke();
  };
  const source = { exchanges: entity, channel: modelHost.interactions.bind(contract), ...(recovery ? { recovery: { read: (id) => modelHost.states.get(id) } } : {}), ...(inspection ? { inspection } : {}) };
  const resources = new Resources().register(new Resource(entity), ModelExchangeResource).register(new Resource(source), ToolModelResource);
  const runner = new Runner(scene, resources, modelHost.interactions, store ? { checkpoints: { store } } : {}).build();
  return { tool, entity, runner };
}
