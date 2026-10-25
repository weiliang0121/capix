import { Group } from '@capix/structure';
import type { RecordingInstallation } from '@capix/server-runtime/recording';
import { documentDescriptor, type TextDocument } from '../files/index.js';
import type { ModelRequest } from './model/types.js';
import type { ConversationStructure } from './structure.js';
import { ConversationGroup } from './conversation.js';
import { GenerateAnswer } from './group/answer/generate.js';
import { ProcessDocument } from './group/document/process.js';
import { SaveResult } from './group/document/save.js';
import { CreateText } from './node/files/create.js';
import { ReadText } from './node/files/read.js';
import { PrepareConversationContext } from './group/context/prepare.js';
import { MaintainConversationContent } from './group/context/maintain.js';
import { describeActiveContent, describePreparedConversationContext } from './content/observation.js';
import type { ActiveContentSnapshot } from './content/active.js';
import type { PreparedConversationContext } from './group/context/types.js';

/** Recording is a host consumer: business structures carry neither observers nor projection callbacks. */
export function registerConversationRecording(recording: RecordingInstallation, structure: ConversationStructure): void {
  const pending = [structure.scene, ...structure.scene.members];
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index]!;
    if (current instanceof Group) pending.push(...current.members);
    if (current instanceof ConversationGroup)
      recording.describe(current, {
        role: 'conversation-task',
        input: ({ message, fileTask }) => ({ ...message, ...(fileTask ? { fileTask } : {}) }),
        relationAccepted: (output, relation) => (relation.key === 'preparation' ? describePreparedConversationContext(output as PreparedConversationContext) : relation.key === 'maintenance' ? describeActiveContent(output as ActiveContentSnapshot) : output),
      });
    if (current instanceof GenerateAnswer) {
      recording.describe(current, { input: (input) => (input.document ? { ...input, document: documentDescriptor(input.document) } : input), ...(current.documentEnabled ? { relationHandled: (value: unknown) => describeRetry(value), relationAccepted: (output: unknown, relation: { readonly key?: string }) => (relation.key === 'request' || relation.key === 'regeneration' ? describeModelRequest(output as ModelRequest) : output) } : {}) });
      if (current.documentEnabled) {
        recording.describe(current.prepareRequest, { input: (input) => ({ ...input, ...(input.document ? { document: documentDescriptor(input.document) } : {}) }), output: describeModelRequest });
        recording.describe(current.prepareRegeneration, { input: (input) => ({ ...input, request: describeModelRequest(input.request) }), output: describeModelRequest });
        recording.describe(current.candidate, { input: describeModelRequest });
        recording.describe(current.candidate.requestModel, { input: describeModelRequest });
        recording.describe(current.candidate.requestModel.invokeModel, { input: describeModelRequest });
      }
    }
    if (current instanceof ProcessDocument) recording.describe(current, { relationAccepted: (output, relation) => (relation.key === 'read' ? documentDescriptor(output as TextDocument) : output) });
    if (current instanceof ReadText) recording.describe(current, { output: documentDescriptor });
    if (current instanceof CreateText || current instanceof SaveResult) recording.describe(current, { input: ({ path, text }) => ({ path, bytes: Buffer.byteLength(text, 'utf8') }) });
    if (current instanceof PrepareConversationContext) recording.describe(current, { output: describePreparedConversationContext, relationAccepted: (output, relation) => (relation.key === 'maintenance' ? describeActiveContent(output as ActiveContentSnapshot) : output) });
    if (current instanceof MaintainConversationContent) recording.describe(current, { output: describeActiveContent });
  }
}

/** Preserve request shape and size without duplicating document text in call records. */
function describeModelRequest(request: ModelRequest): unknown {
  return { ...request, messages: request.messages.map(({ role, content }) => ({ role, bytes: Buffer.byteLength(content, 'utf8') })) };
}

function describeRetry(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'retry' || !('basis' in value)) return value;
  const basis = value.basis as import('./model/regeneration.js').ModelRegenerationInput;
  return { ...value, basis: { ...basis, request: describeModelRequest(basis.request) } };
}
