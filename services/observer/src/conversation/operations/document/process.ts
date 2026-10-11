import { OperationDefinition, Sequence, type OperationContextView, type InvocationView, type ChildBindings } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { GenerationOutput } from '@capix/protocol';
import { FileResources, documentDescriptor, type TextDocument, type FileReader } from '../../../files/index.js';
import { GenerateAnswerDefinition, type GenerationInput } from '../answer/generate.js';
import { ReadTextDefinition } from '../../attempt/files/read.js';
import type { ConversationResources } from '../../resources.js';

export interface DocumentProcessingInput extends GenerationInput {
  readonly sourcePath: string;
}
export interface DocumentProcessingResources extends ConversationResources {
  readonly reader: FileReader;
}

/** Read and generate only. E commits the answer before submitting a separate save operation. */
export class ProcessDocumentDefinition extends OperationDefinition<DocumentProcessingInput, GenerationOutput, DocumentProcessingResources> {
  readonly name = 'processDocument';
  readonly label = '处理文档';
  readonly source = 'services/observer/src/conversation/operations/document/process.ts · ProcessDocumentDefinition';
  readonly observation = [invocationRecording({ relationAccepted: (output, relation) => (relation.key === 'read' ? documentDescriptor(output as TextDocument) : output) })];
  readonly readDefinition = new ReadTextDefinition();
  readonly generationDefinition = new GenerateAnswerDefinition({ document: true, files: true });
  readonly children = [this.readDefinition, this.generationDefinition];
  static readonly requires = Object.freeze({ ...GenerateAnswerDefinition.requires, reader: FileResources.readText.request() });
  readonly run = { requires: ProcessDocumentDefinition.requires, uses: this.children, execute: this.execute.bind(this) };
  private readonly composition = new Sequence<DocumentProcessingInput, InvocationView<unknown, unknown, OperationContextView>>().step('read', { use: this.readDefinition, input: ({ input }) => ({ path: input.sourcePath }) }).step('generation', { use: this.generationDefinition, input: ({ input, outputs }) => ({ selection: input.selection, memories: input.memories, task: input.task, document: outputs.read }) });

  private async execute(context: OperationContextView<DocumentProcessingInput, GenerationOutput, DocumentProcessingResources>, invocation: InvocationView<DocumentProcessingInput, GenerationOutput, OperationContextView<DocumentProcessingInput, GenerationOutput, DocumentProcessingResources>>, children: ChildBindings): Promise<GenerationOutput> {
    return (await this.composition.run(invocation, context.currentInput, children)).generation;
  }
}
