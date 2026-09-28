import { Execution, type ExecutionContext, type ExecutionOptions, type Runtime, TranscriptRangeRef } from '@capix-observer/runtime';

import type { Message, GenerationOutput } from '@capix-observer/protocol';

import type { ModelProvider } from '../provider.js';

import { SelectHistory } from '../operations/history/select.js';

import { ExtractMemory } from '../operations/memory/extract.js';
import { prepareMemoryInput } from '../operations/memory/input.js';

import { GenerateAnswer } from '../operations/answer/generate.js';
import { segmentCandidates } from './segment.js';

/** The fixed composition used by this experiment, reusable across calls. */
export class ObserverExecution extends Execution<Readonly<Message>, GenerationOutput> {
  readonly selection: SelectHistory;
  readonly generation: GenerateAnswer;
  readonly extraction: ExtractMemory;

  constructor(runtime: Runtime, provider: ModelProvider) {
    super(runtime);
    this.selection = new SelectHistory(runtime, provider);
    this.generation = new GenerateAnswer(runtime, provider);
    this.extraction = new ExtractMemory(runtime, provider, this.runtime.memories);
  }

  protected override prepare(input: Readonly<Message>, options: ExecutionOptions): void {
    if (!options.signal?.aborted) this.prepareSegment(input, options);
  }

  private prepareSegment(message: Readonly<Message>, options: ExecutionOptions): void {
    const transcript = this.runtime.transcript;
    if (!transcript || transcript.get(transcript.length - 1) !== message) return;
    const range = new TranscriptRangeRef(transcript, transcript.activeStart, transcript.length);
    const input = { message, memories: this.runtime.memories.snapshot() };
    if (range.length <= 1 || this.selection.capacity(input, range, options.settings).fits) return;
    const next = segmentCandidates(range).find((candidate) => this.selection.capacity(input, candidate, options.settings).fits);
    // Do not accumulate empty segments when memory/current input alone cannot fit.
    if (next) transcript.startSegment(next.start);
  }

  protected async execute(context: ExecutionContext<Readonly<Message>, GenerationOutput>): Promise<GenerationOutput> {
    const range = context.transcriptRange!;
    const previousMemories = this.runtime.memories.snapshot();
    const selectionInput = { message: context.currentInput, memories: previousMemories };
    const selectionOutput = await this.selection.call(context, selectionInput);
    this.runtime.selectionUsage.add(selectionOutput.historyIndexes.map((index) => context.transcriptRange!.read(index)));
    const generationOutput = await this.generation.call(context, { selection: selectionOutput, memories: previousMemories });
    const responseIndex = range.transcript.length;
    range.transcript.appendFrom([{ role: 'assistant', content: generationOutput.content }], { contextId: context.id });
    const extractionInput = prepareMemoryInput(range, range.transcript.ref(responseIndex), selectionOutput.historyIndexes, previousMemories);
    await this.extraction.call(context, extractionInput);
    return generationOutput;
  }
}
