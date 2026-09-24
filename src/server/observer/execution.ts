import { Execution } from '../execution/execution.js';
import type { ExecutionContext, ExecutionOptions } from '../context/execution.js';
import type { Message } from '../../shared/transcript/message.js';
import type { GenerationOutput } from '../../shared/operations/generation.js';
import type { ModelProvider } from '../provider.js';
import type { Runtime } from '../runtime/runtime.js';
import { SelectHistory } from '../operations/history/select.js';
import { AssembleContext } from '../operations/context/assemble.js';
import { MemoryCollection } from '../memory/collection.js';
import { ExtractMemory } from '../operations/memory/extract.js';
import { prepareMemoryInput } from '../operations/memory/input.js';
import { TranscriptRangeRef } from '../transcript/ref.js';
import { GenerateAnswer } from '../operations/answer/generate.js';
import { segmentCandidates } from './segment.js';

/** The fixed composition used by this experiment, reusable across calls. */
export class ObserverExecution extends Execution<Readonly<Message>, GenerationOutput> {
  readonly selection: SelectHistory;
  readonly assembly: AssembleContext;
  readonly generation: GenerateAnswer;
  readonly extraction: ExtractMemory;
  readonly memories = new MemoryCollection();

  constructor(runtime: Runtime, provider: ModelProvider) {
    super(runtime);
    this.selection = new SelectHistory(runtime, provider);
    this.assembly = new AssembleContext(runtime);
    this.generation = new GenerateAnswer(runtime, provider);
    this.extraction = new ExtractMemory(runtime, provider, this.memories);
  }

  override call(input: Readonly<Message>, options: ExecutionOptions, started?: (context: ExecutionContext<Readonly<Message>, GenerationOutput>) => void): Promise<GenerationOutput> {
    this.prepareSegment(input, options);
    return super.call(input, options, started);
  }

  private prepareSegment(message: Readonly<Message>, options: ExecutionOptions): void {
    const transcript = options.transcript;
    if (!transcript || transcript.get(transcript.length - 1) !== message) return;
    const range = new TranscriptRangeRef(transcript, transcript.activeStart, transcript.length);
    const input = { message, memories: this.memories.values(transcript).map((memory) => memory.toJSON()) };
    if (range.length <= 1 || this.selection.capacity(input, range, options.settings).fits) return;
    const next = segmentCandidates(range).find((candidate) => this.selection.capacity(input, candidate, options.settings).fits);
    // Do not accumulate empty segments when memory/current input alone cannot fit.
    if (next) transcript.startSegment(next.start);
  }

  protected async execute(context: ExecutionContext<Readonly<Message>, GenerationOutput>): Promise<GenerationOutput> {
    const range = context.transcriptRange!;
    const previousMemories = this.memories.values(range.transcript).map((memory) => memory.toJSON());
    const selectionInput = { message: context.input, memories: previousMemories };
    const selectionOutput = await this.selection.call(context, selectionInput);
    this.selection.usage.add(selectionOutput.historyIndexes.map((index) => context.transcriptRange!.read(index)));
    const assemblyOutput = await this.assembly.call(context, selectionOutput);
    const generationOutput = await this.generation.call(context, { ...assemblyOutput, memories: previousMemories });
    const responseIndex = range.transcript.length;
    range.transcript.append({ role: 'assistant', content: generationOutput.content });
    const extractionInput = prepareMemoryInput(range, range.transcript.ref(responseIndex), assemblyOutput.selectedMessages, previousMemories);
    await this.extraction.call(context, extractionInput);
    return generationOutput;
  }
}
