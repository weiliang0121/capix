import { z } from 'zod';
import { isEqual } from 'es-toolkit/predicate';
import { checkpointCodec } from '../../checkpoint.js';
import { answerCheckpointCodecs } from '../answer/checkpoint.js';
import { selectionSchema, memorySchema, fileTaskSchema, childWaitingCodec, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { OperationDefinition, type OperationContextView, type InvocationWorkView, type ChildBindings, type ChildInvocationView, type InvocationCheckpointDefinition } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { GenerationOutput } from '@capix/protocol';
import { FileResources, documentDescriptor, type TextDocument, type FileReader } from '../../../files/index.js';
import { GenerateAnswerDefinition, type GenerationInput } from '../answer/generate.js';
import { ReadTextDefinition } from '../../attempt/files/read.js';
import type { ConversationResources } from '../../resources.js';
import { answerStream, type AnswerGenerationEvent } from '../answer/stream.js';
type DocumentCall = InvocationWorkView<DocumentProcessingInput, GenerationOutput, OperationContextView<DocumentProcessingInput, GenerationOutput, DocumentProcessingResources>, AnswerGenerationEvent>;

export interface DocumentProcessingInput extends GenerationInput {
  readonly sourcePath: string;
}
export interface DocumentProcessingResources extends ConversationResources {
  readonly reader: FileReader;
}

/** Read and generate only. E commits the answer before submitting a separate save operation. */
export class ProcessDocumentDefinition extends OperationDefinition<DocumentProcessingInput, GenerationOutput, DocumentProcessingResources, Record<string, never>, AnswerGenerationEvent> {
  readonly output = { result: answerStream.result, delta: (value: unknown) => value as AnswerGenerationEvent };
  readonly name = 'processDocument';
  readonly label = '处理文档';
  readonly source = 'services/observer/src/conversation/operations/document/process.ts · ProcessDocumentDefinition';
  readonly observation = [invocationRecording({ relationAccepted: (output, relation) => (relation.key === 'read' ? documentDescriptor(output as TextDocument) : output) })];
  readonly readDefinition = new ReadTextDefinition();
  readonly generationDefinition = new GenerateAnswerDefinition({ document: true, files: true });
  readonly children = [this.readDefinition, this.generationDefinition];
  static readonly requires = Object.freeze({ ...GenerateAnswerDefinition.requires, reader: FileResources.readText.request() });
  readonly checkpoint: InvocationCheckpointDefinition<DocumentProcessingInput, GenerationOutput, OperationContextView<DocumentProcessingInput, GenerationOutput, DocumentProcessingResources>, AnswerGenerationEvent> = {
    key: 'observer.process-document',
    version: 1,
    input: checkpointCodec(z.strictObject({ sourcePath: z.string().min(1), selection: selectionSchema, memories: z.array(memorySchema), task: z.strictObject({ fileTask: fileTaskSchema, instruction: z.string().min(1) }).optional() })),
    output: answerCheckpointCodecs.output,
    points: {
      reading: {
        state: childWaitingCodec,
        check: (frame, state) => {
          originalCheckpoint(frame);
          const child = waitingChild(frame, state, 'read', this.readDefinition.checkpoint);
          if (frame.children.length !== 1 || !isEqual(child.input, { path: (frame.currentInput as { sourcePath: string }).sourcePath })) throw new Error('Document checkpoint changed source path');
        },
        resume: { requires: {}, uses: this.children, execute: (context, invocation, children, state: { childId: string }) => this.receiveDocument(context.currentInput, invocation, children, children.get(this.readDefinition).resume(invocation, state.childId)) },
      },
      generating: {
        state: childWaitingCodec,
        check: (frame, state) => {
          originalCheckpoint(frame);
          const child = waitingChild(frame, state, 'generation', this.generationDefinition.checkpoint);
          const read = acceptedChild(frame.children[0]);
          const input = frame.currentInput as unknown as DocumentProcessingInput;
          if (frame.children.length !== 2 || read.key !== 'read' || !isEqual(child.input, this.generationInput(input, read.state.reception.output as unknown as TextDocument))) throw new Error('Document checkpoint changed fixed document');
        },
        resume: { requires: {}, uses: [this.generationDefinition], execute: (_context, invocation, children, state: { childId: string }) => this.receiveGeneration(invocation, children, children.get(this.generationDefinition).resume(invocation, state.childId)) },
      },
      result: {
        state: answerCheckpointCodecs.output,
        check: (frame, output) => {
          originalCheckpoint(frame);
          const child = acceptedChild(frame.children[1]);
          if (frame.children.length !== 2 || child.key !== 'generation' || !isEqual(child.state.reception.output, output)) throw new Error('Document checkpoint differs from accepted generation');
        },
        resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, output: GenerationOutput) => output },
      },
    },
  };
  readonly run = { requires: ProcessDocumentDefinition.requires, uses: this.children, execute: this.execute.bind(this) };
  private async execute(context: OperationContextView<DocumentProcessingInput, GenerationOutput, DocumentProcessingResources>, invocation: DocumentCall, children: ChildBindings): Promise<GenerationOutput> {
    const read = children.get(this.readDefinition).create(invocation, { path: context.currentInput.sourcePath }, { key: 'read' });
    invocation.checkpoint?.save('reading', { childId: read.context.id });
    return this.receiveDocument(context.currentInput, invocation, children, read);
  }
  private generationInput(input: DocumentProcessingInput, document: TextDocument): GenerationInput {
    return { selection: input.selection, memories: input.memories, ...(input.task ? { task: input.task } : {}), document };
  }
  private async receiveDocument(input: DocumentProcessingInput, invocation: InvocationWorkView<DocumentProcessingInput, GenerationOutput, OperationContextView<DocumentProcessingInput, GenerationOutput, any>, AnswerGenerationEvent>, children: ChildBindings, read: ChildInvocationView<{ readonly path: string }, TextDocument>): Promise<GenerationOutput> {
    await read.run();
    const document = await children.accept(read, (value) => value);
    const generation = children.get(this.generationDefinition).create(invocation, this.generationInput(input, document), {
      key: 'generation',
      output: {
        receive: (event) => {
          invocation.output.emit(event);
        },
      },
    });
    invocation.checkpoint?.save('generating', { childId: generation.context.id });
    return this.receiveGeneration(invocation, children, generation);
  }
  private async receiveGeneration(invocation: InvocationWorkView<DocumentProcessingInput, GenerationOutput, OperationContextView<DocumentProcessingInput, GenerationOutput, any>, AnswerGenerationEvent>, children: ChildBindings, generation: ChildInvocationView<GenerationInput, GenerationOutput>): Promise<GenerationOutput> {
    await generation.run();
    const output = await children.accept(generation, (value) => value);
    invocation.checkpoint?.save('result', output);
    return output;
  }
}
