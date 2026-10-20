import { z } from 'zod';
import { isEqual } from 'es-toolkit/predicate';
import { checkpointCodec } from '../../checkpoint.js';
import { answerCheckpointCodecs } from '../answer/checkpoint.js';
import { answerMessageContextSchema, memorySchema, fileTaskSchema, emptyCheckpointState, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { GroupDefinition, checkpointPoint, childReference, type GroupWork, type ChildCall, type ChildrenOf } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { GenerationOutput } from '@capix/protocol';
import { FileResources, documentDescriptor, type TextDocument, type FileReader } from '../../../files/index.js';
import { GenerateAnswerDefinition, type GenerationInput } from '../answer/generate.js';
import { ReadTextDefinition } from '../../node/files/read.js';
import type { ModelCallResources } from '../../resources.js';
import { answerStream, type AnswerGenerationEvent } from '../answer/stream.js';
type DocumentWork = GroupWork<DocumentProcessingInput, GenerationOutput, object, ChildrenOf<'group'>, AnswerGenerationEvent>;

export interface DocumentProcessingInput extends GenerationInput {
  readonly sourcePath: string;
}
export interface DocumentProcessingResources extends ModelCallResources {
  readonly reader: FileReader;
}

/** Read and generate only. E commits the answer before submitting a separate save operation. */
export class ProcessDocumentDefinition extends GroupDefinition<DocumentProcessingInput, GenerationOutput, DocumentProcessingResources, Record<string, never>, AnswerGenerationEvent> {
  readonly output = { result: answerStream.result, delta: (value: unknown) => value as AnswerGenerationEvent };
  readonly name = 'processDocument';
  readonly label = '处理文档';
  readonly source = 'services/observer/src/conversation/group/document/process.ts · ProcessDocumentDefinition';
  readonly observation = [invocationRecording({ relationAccepted: (output, relation) => (relation.key === 'read' ? documentDescriptor(output as TextDocument) : output) })];
  readonly readDefinition = new ReadTextDefinition();
  readonly generationDefinition = new GenerateAnswerDefinition({ document: true, files: true });
  readonly members = [this.readDefinition, this.generationDefinition];
  static readonly requires = Object.freeze({ ...GenerateAnswerDefinition.requires, reader: FileResources.readText.request() });
  readonly points = {
    reading: checkpointPoint<'group', DocumentProcessingInput, GenerationOutput, AnswerGenerationEvent>()({
      name: 'reading',
      state: emptyCheckpointState,
      references: { child: childReference(this.readDefinition) },
      check: (_state, facts) => {
        originalCheckpoint(facts);
        const child = waitingChild(facts, facts.references.child, 'read');
        if (facts.children.values().length !== 1 || !isEqual(child.input, { path: facts.input.sourcePath })) throw new Error('Document checkpoint changed source path');
      },
      resume: { uses: this.members, execute: (work, _state, saved) => this.receiveDocument(work, work.children.resume(saved.child)) },
    }),
    generating: checkpointPoint<'group', DocumentProcessingInput, GenerationOutput, AnswerGenerationEvent>()({
      name: 'generating',
      state: emptyCheckpointState,
      references: { child: childReference(this.generationDefinition) },
      check: (_state, facts) => {
        originalCheckpoint(facts);
        const child = waitingChild(facts, facts.references.child, 'generation');
        const read = acceptedChild(facts.children.requireUnique(this.readDefinition, { parentRound: 1 }));
        if (facts.children.values().length !== 2 || read.key !== 'read' || !isEqual(read.reception.value, read.returned.output) || !isEqual(child.input, this.generationInput(facts.input, read.returned.output))) throw new Error('Document checkpoint changed fixed document');
      },
      resume: { uses: [this.generationDefinition], execute: (work, _state, saved) => this.receiveGeneration(work, work.children.resume(saved.child)) },
    }),
    result: checkpointPoint<'group', DocumentProcessingInput, GenerationOutput, AnswerGenerationEvent>()({
      name: 'result',
      state: answerCheckpointCodecs.output,
      references: {},
      check: (output, facts) => {
        originalCheckpoint(facts);
        const child = acceptedChild(facts.children.requireUnique(this.generationDefinition, { parentRound: 1 }));
        if (facts.children.values().length !== 2 || child.key !== 'generation' || !isEqual(child.reception.value, output)) throw new Error('Document checkpoint differs from accepted generation');
      },
      resume: { execute: (_work, output) => output },
    }),
  };
  readonly checkpoint = {
    key: 'observer.process-document',
    version: 3,
    input: checkpointCodec(z.strictObject({ sourcePath: z.string().min(1), context: answerMessageContextSchema, memories: z.array(memorySchema), task: z.strictObject({ fileTask: fileTaskSchema, instruction: z.string().min(1) }).optional() })),
    output: answerCheckpointCodecs.output,
    points: Object.values(this.points),
  };
  readonly run = { requires: ProcessDocumentDefinition.requires, uses: this.members, execute: this.execute.bind(this) };
  private async execute(work: DocumentWork): Promise<GenerationOutput> {
    const read = work.children.create(this.readDefinition, { path: work.input.sourcePath }, { key: 'read' });
    work.checkpoint?.save(this.points.reading, null, { child: read.ref });
    return this.receiveDocument(work, read);
  }
  private generationInput(input: DocumentProcessingInput, document: TextDocument): GenerationInput {
    return { context: input.context, memories: input.memories, ...(input.task ? { task: input.task } : {}), document };
  }
  private async receiveDocument(work: DocumentWork, read: ChildCall<ReadTextDefinition>): Promise<GenerationOutput> {
    await read.run();
    const document = await read.accept();
    const generation = work.children.create(this.generationDefinition, this.generationInput(work.input, document), {
      key: 'generation',
      output: {
        receive: (event) => {
          work.output.emit(event);
        },
      },
    });
    work.checkpoint?.save(this.points.generating, null, { child: generation.ref });
    return this.receiveGeneration(work, generation);
  }
  private async receiveGeneration(work: DocumentWork, generation: ChildCall<GenerateAnswerDefinition>): Promise<GenerationOutput> {
    await generation.run();
    const output = await generation.accept();
    work.checkpoint?.save(this.points.result, output, {});
    return output;
  }
}
