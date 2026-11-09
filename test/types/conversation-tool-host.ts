import { z } from 'zod';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import type { ModelProvider, ModelRequestInspection } from '@weiliang0121/capix-model-provider';
import type { InteractionChannel } from '@weiliang0121/capix-interaction';
import type { ModelRequest, ModelReply } from '@weiliang0121/capix-model-provider';
import { createToolLoop, tool } from '@capix/conversation-service/tools';
import { createArchivedToolAnswer, registerArchivedToolResources, type ToolHostOptions, type ToolExchangeUse } from '@capix/conversation-service/tools/hosting';
import type { ConversationMaterialInput } from '@capix/conversation-service';

const node = new Node<{ text: string }, string>({ run: (work) => work.input.text });
const loop = createToolLoop({ policyVersion: 'test', tools: { echo: tool(node, { description: 'echo', input: z.strictObject({ text: z.string() }), maxOutputBytes: 1024, result: { succeeded: (text) => ({ status: 'ok', content: [{ kind: 'text', text }] }) } }) } });
const answer = createArchivedToolAnswer(loop);
const resources = new Resources<ToolHostOptions>();
declare const channel: InteractionChannel<ModelRequest, ModelReply, string>;
declare const inspection: (request: ModelRequest) => ModelRequestInspection;
registerArchivedToolResources(resources, answer, loop, channel, inspection);
// @ts-expect-error Registration must preserve a host use in the entry options type.
registerArchivedToolResources(new Resources(), answer, loop, channel, inspection);
// @ts-expect-error Provider request preflight must return both accurate byte measurements.
registerArchivedToolResources(resources, answer, loop, channel, () => ({ wireBytes: 1 }));
const scene = new Scene<ConversationMaterialInput, string>().add({ answer });
scene.run = (work) => work.children.answer.invoke(work.input);
const runner = new Runner(scene, resources).build();
declare const input: ConversationMaterialInput;
declare const use: ToolExchangeUse;
runner.run(input, { exchangeUse: use });
// @ts-expect-error A host cannot omit the use required by both capture scopes.
runner.run(input);
// @ts-expect-error Resources cannot accept an arbitrary structural object as a use.
runner.run(input, { exchangeUse: {} });
// Optional inspection leaves text-only providers valid; the tool host checks it at assembly.
declare const textProvider: ModelProvider;
textProvider.complete({ messages: [{ role: 'user', content: 'hello' }] });
