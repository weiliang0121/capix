import { z } from 'zod';
import { isEqual } from 'es-toolkit/predicate';
import { checkpointCodec } from '../../checkpoint.js';
import { answerCheckpointCodecs } from '../answer/checkpoint.js';
import { answerMessageContextSchema, memorySchema, fileTaskSchema, emptyCheckpointState, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { Group, checkpointPoint, childReference, type GroupWork, type ChildCall, type ChildrenOf } from '@capix/server-runtime';
import type { GenerationOutput } from '@capix/protocol';
import { FileResources, type TextDocument, type FileReader } from '../../../files/index.js';
import { GenerateAnswer, type GenerationInput } from '../answer/generate.js';
import { ReadText } from '../../node/files/read.js';
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
export class ProcessDocument extends Group<DocumentProcessingInput, GenerationOutput, DocumentProcessingResources, AnswerGenerationEvent> {
  readonly readText;
  readonly generation;

  static readonly deps = Object.freeze({ ...GenerateAnswer.deps, reader: FileResources.readText.request() });
  readonly points;

  constructor() {
    super();

    this.readText = new ReadText();
    this.generation = new GenerateAnswer({ document: true, files: true });
    this.add(this.readText, this.generation);
    this.points = {
      reading: checkpointPoint<'group', DocumentProcessingInput, GenerationOutput, AnswerGenerationEvent>()({
        name: 'reading',
        state: emptyCheckpointState,
        references: { child: childReference(this.readText) },
        check: (_state, facts) => {
          originalCheckpoint(facts);
          const child = waitingChild(facts, facts.references.child, 'read');
          if (facts.children.values().length !== 1 || !isEqual(child.input, { path: facts.input.sourcePath })) throw new Error('Document checkpoint changed source path');
        },
        resume: { uses: this.members, run: (work, _state, saved) => this.receiveDocument(work, work.children.resume(saved.child)) },
      }),
      generating: checkpointPoint<'group', DocumentProcessingInput, GenerationOutput, AnswerGenerationEvent>()({
        name: 'generating',
        state: emptyCheckpointState,
        references: { child: childReference(this.generation) },
        check: (_state, facts) => {
          originalCheckpoint(facts);
          const child = waitingChild(facts, facts.references.child, 'generation');
          const read = acceptedChild(facts.children.requireUnique(this.readText, { parentRound: 1 }));
          if (facts.children.values().length !== 2 || read.key !== 'read' || !isEqual(read.reception.value, read.returned.output) || !isEqual(child.input, this.generationInput(facts.input, read.returned.output))) throw new Error('Document checkpoint changed fixed document');
        },
        resume: { uses: [this.generation], run: (work, _state, saved) => this.receiveGeneration(work, work.children.resume(saved.child)) },
      }),
      result: checkpointPoint<'group', DocumentProcessingInput, GenerationOutput, AnswerGenerationEvent>()({
        name: 'result',
        state: answerCheckpointCodecs.output,
        references: {},
        check: (output, facts) => {
          originalCheckpoint(facts);
          const child = acceptedChild(facts.children.requireUnique(this.generation, { parentRound: 1 }));
          if (facts.children.values().length !== 2 || child.key !== 'generation' || !isEqual(child.reception.value, output)) throw new Error('Document checkpoint differs from accepted generation');
        },
        resume: { run: (_work, output) => output },
      }),
    };

    this.output = { result: answerStream.result, delta: (value: unknown) => value as AnswerGenerationEvent };
    this.name = 'processDocument';
    this.label = '处理文档';
    this.source = 'services/observer/src/conversation/group/document/process.ts · ProcessDocument';
    this.checkpoint = {
      key: 'observer.process-document',
      version: 4,
      input: checkpointCodec(z.strictObject({ sourcePath: z.string().min(1), context: answerMessageContextSchema, memories: z.array(memorySchema), task: z.strictObject({ fileTask: fileTaskSchema, instruction: z.string().min(1) }).optional() })),
      output: answerCheckpointCodecs.output,
      points: Object.values(this.points),
    };
    this.deps = ProcessDocument.deps;
    this.run = this.execute.bind(this);
  }

  private async execute(work: DocumentWork): Promise<GenerationOutput> {
    const read = work.children.create(this.readText, { path: work.input.sourcePath }, { key: 'read' });
    work.checkpoint?.({ point: this.points.reading, state: null, refs: { child: read.ref } });
    return this.receiveDocument(work, read);
  }
  private generationInput(input: DocumentProcessingInput, document: TextDocument): GenerationInput {
    return { context: input.context, memories: input.memories, ...(input.task ? { task: input.task } : {}), document };
  }
  private async receiveDocument(work: DocumentWork, read: ChildCall<ReadText>): Promise<GenerationOutput> {
    const document = await read.invoke();
    const generation = work.children.create(this.generation, this.generationInput(work.input, document), {
      key: 'generation',
      output: {
        receive: (event) => {
          if (event.kind === 'delta') work.output.emit(event.delta);
        },
      },
    });
    work.checkpoint?.({ point: this.points.generating, state: null, refs: { child: generation.ref } });
    return this.receiveGeneration(work, generation);
  }
  private async receiveGeneration(work: DocumentWork, generation: ChildCall<GenerateAnswer>): Promise<GenerationOutput> {
    const output = await generation.invoke();
    work.checkpoint?.({ point: this.points.result, state: output, refs: {} });
    return output;
  }
}
