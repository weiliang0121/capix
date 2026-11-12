import { z } from 'zod';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Interactions } from '@weiliang0121/capix-interaction';
import { requireModelRequest, requireModelReply } from '@weiliang0121/capix-model-provider';
import { ModelExchanges, ModelExchangeResource } from '@weiliang0121/capix-model-exchanges';
import { Tool, ToolModelResource } from '@weiliang0121/capix-tool';

// 同一棵结构用于离线脚本和真实模型；业务实体由宿主提供。
export function createNotesAssistant(provider, notes, { onRead = () => {}, onWrite = () => {} } = {}) {
  // #region resources
  const reading = new ResourceOffer({
    methods: {
      read(notes, id) {
        const note = notes.read(id);
        onRead(note); // 仅在真实读取成功后输出宿主日志。
        return note;
      },
    },
  });
  const writing = new ResourceOffer({
    methods: {
      append(notes, value) {
        const note = notes.append(value);
        onWrite(note);
        return note;
      },
    },
  });
  // #endregion resources

  // #region tools
  const readNote = new Node({
    deps: { notes: reading.request() },
    run: (work) => work.resources.notes.read(work.input.id),
  });
  const writeNote = new Node({
    deps: { notes: writing.request() },
    run: (work) => work.resources.notes.append(work.input),
  });
  const result = { succeeded: (note) => ({ status: 'ok', content: [{ kind: 'text', text: JSON.stringify(note) }] }) };
  const assistant = new Tool({
    policyVersion: 'notes-assistant.v1',
    waitMs: 65000, // Provider 默认超时 60 秒；局部等待结束不取消独立发送。
    tools: {
      readNote: { node: readNote, description: 'Read an existing note by its supplied id.', input: z.strictObject({ id: z.uuid() }), result },
      writeNote: { node: writeNote, description: 'Append a new note without changing existing notes.', input: z.strictObject({ title: z.string().min(1), text: z.string().min(1) }), result },
    },
  });
  // #endregion tools

  // #region model
  const contract = { key: 'example.notes.model.v1', request: requireModelRequest, reply: requireModelReply };
  const interactions = new Interactions().register(contract, { send: (request) => provider.complete(request) });
  const exchanges = new ModelExchanges();
  const resources = new Resources()
    .register(new Resource(notes), reading)
    .register(new Resource(notes), writing)
    .register(new Resource(exchanges), ModelExchangeResource)
    .register(new Resource({ exchanges, channel: interactions.bind(contract), ...(provider.inspectRequest ? { inspection: provider } : {}) }), ToolModelResource);
  const runner = new Runner(new Scene(assistant), resources, interactions).build();
  return { runner, interactions };
  // #endregion model
}
