import { invocationRecording } from '@capix/server-runtime/recording';
import { ExecutionDefinition, type InvocationView, type ExecutionContextView, type ChildBindings } from '@capix/server-runtime';
import type { GenerationOutput, ConversationTask } from '@capix/protocol';
import { conversationExecutionRequests, conversationEntryRequests, type ConversationExecutionResources, type ConversationEntryResources } from './resources.js';
import { prepareMemoryInput } from './operations/memory/input.js';
import type { SelectHistoryDefinition } from './operations/history/select.js';
import type { ExtractMemoryDefinition } from './operations/memory/extract.js';
import { acceptConversationRequest, type AcceptedConversationInput } from './accept.js';
import { prepareConversationSegment } from './admission.js';
import type { GenerateAnswerDefinition } from './operations/answer/generate.js';
import { ProcessDocumentDefinition } from './operations/document/process.js';
import { SaveResultDefinition } from './operations/document/save.js';
import type { UnderstandRequestDefinition } from './operations/request/understand.js';
import { acceptRequestProposal, type RequestProposal } from './operations/request/output.js';

export interface ConversationOperationDefinitions {
  readonly selection: SelectHistoryDefinition;
  readonly generation: GenerateAnswerDefinition;
  readonly extraction: ExtractMemoryDefinition;
  readonly document?: ProcessDocumentDefinition;
  readonly understanding?: UnderstandRequestDefinition;
  readonly save?: SaveResultDefinition;
}

/** The reference conversation composition, reusable across calls. */
export class ConversationExecutionDefinition extends ExecutionDefinition<AcceptedConversationInput, GenerationOutput, ConversationExecutionResources, unknown, ConversationEntryResources> {
  readonly observation = [invocationRecording<AcceptedConversationInput, GenerationOutput>({ input: ({ message, fileTask }) => ({ ...message, ...(fileTask ? { fileTask } : {}) }) })];
  readonly run;
  readonly entry;
  readonly children;

  constructor(readonly operationDefinitions: ConversationOperationDefinitions) {
    super();
    if (Boolean(operationDefinitions.document) !== Boolean(operationDefinitions.save)) throw new Error('File conversation requires both document processing and save declarations');
    this.children = Object.freeze(Object.values(operationDefinitions).filter((definition) => definition !== undefined));
    this.entry = {
      requires: conversationEntryRequests,
      accept: (input: unknown, resources: ConversationEntryResources) => acceptConversationRequest(input, resources.messages.append, Boolean(operationDefinitions.document)),
      admit: (input: AcceptedConversationInput, resources: ConversationEntryResources) => prepareConversationSegment(input.message, resources),
    };
    this.run = { requires: { ...conversationExecutionRequests, ...(operationDefinitions.document ? ProcessDocumentDefinition.requires : {}), ...(operationDefinitions.save ? SaveResultDefinition.requires : {}) }, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: ExecutionContextView<AcceptedConversationInput, GenerationOutput, ConversationExecutionResources>, invocation: InvocationView<AcceptedConversationInput, GenerationOutput, ExecutionContextView<AcceptedConversationInput, GenerationOutput, ConversationExecutionResources>>, children: ChildBindings): Promise<GenerationOutput> {
    const { message, fileTask } = context.currentInput;
    const resources = context.resources.values;
    const memories = resources.memories;
    const selection = children.get(this.operationDefinitions.selection).create(invocation, { message, memories }, { key: 'selection' });
    const selected = await selection.run();
    await children.accept(selection, () => {
      resources.selectionUsage.add(selected.historyIndexes.map((index) => resources.history.read(index)));
      return selected;
    });
    let proposal: RequestProposal = fileTask ? { kind: 'file', task: fileTask, instruction: message.content } : { kind: 'reply' };
    if (!fileTask && this.operationDefinitions.understanding) {
      const understanding = children.get(this.operationDefinitions.understanding).create(invocation, { message, selection: selected, memories }, { key: 'understanding' });
      const proposed = await understanding.run();
      proposal = await children.accept(understanding, () => acceptRequestProposal(proposed, { files: Boolean(this.operationDefinitions.document && this.operationDefinitions.save) }));
    }
    const task: ConversationTask = proposal.kind === 'file' ? { kind: 'file', task: proposal.task } : { kind: proposal.kind };
    resources.tasks.select(task);
    if (proposal.kind === 'clarify' || proposal.kind === 'unsupported') {
      const answer: GenerationOutput = proposal.kind === 'clarify' ? { kind: 'needs-info', content: proposal.question } : { kind: 'unknown', content: proposal.explanation };
      resources.messages.append([{ role: 'assistant', content: answer.content }]);
      return answer;
    }
    const input = { selection: selected, memories, ...(proposal.kind === 'file' ? { task: { fileTask: proposal.task, instruction: proposal.instruction } } : {}) };
    const generation = proposal.kind === 'file' && proposal.task.sourcePath !== undefined && this.operationDefinitions.document ? children.get(this.operationDefinitions.document).create(invocation, { ...input, sourcePath: proposal.task.sourcePath }, { key: 'generation' }) : children.get(this.operationDefinitions.generation).create(invocation, input, { key: 'generation' });
    const answer = await generation.run();
    const accepted = await children.accept(generation, () => ({ answer, response: resources.messages.append([{ role: 'assistant', content: answer.content }])[0]! }));
    if (proposal.kind === 'file' && proposal.task.output && answer.kind === 'answer' && this.operationDefinitions.save) {
      const save = children.get(this.operationDefinitions.save).create(invocation, { path: proposal.task.output.path, text: answer.content }, { key: 'save' });
      const receipt = await save.run();
      await children.accept(save, () => receipt);
    }
    const extraction = children.get(this.operationDefinitions.extraction).create(invocation, prepareMemoryInput(resources.history, accepted.response, selected.historyIndexes, memories), { key: 'extraction' });
    const extracted = await extraction.run();
    await children.accept(extraction, () => extracted);
    return answer;
  }
}
