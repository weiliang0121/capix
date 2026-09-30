import { Sequence } from '@capix-observer/runtime';
import type { MemoryInput } from '../operations/memory/input.js';
import type { Invocation, ExecutionStarted } from '@capix-observer/runtime';
import { Execution, type ExecutionContext, type ExecutionOptions, type Runtime, TranscriptRangeRef } from '@capix-observer/runtime';

import type { Message, GenerationOutput, ConversationUpdate } from '@capix-observer/protocol';

import type { ModelProvider } from '../provider.js';

import { SelectHistory } from '../operations/history/select.js';

import { ExtractMemory } from '../operations/memory/extract.js';
import { prepareMemoryInput } from '../operations/memory/input.js';

import { GenerateAnswer } from '../operations/answer/generate.js';
import { segmentCandidates } from './segment.js';

type ObserverInvocation = Invocation<Readonly<Message>, GenerationOutput, ExecutionContext<Readonly<Message>, GenerationOutput>>;
type ConversationInput = { message: Readonly<Message>; memories: MemoryInput['memories'] };

/** The fixed composition used by this experiment, reusable across calls. */
export class ObserverExecution extends Execution<Readonly<Message>, GenerationOutput> {
  private readonly deliveries = new WeakMap<ExecutionContext<Readonly<Message>, GenerationOutput>, (update: ConversationUpdate) => void>();

  async converse(accept: () => Readonly<Message>, options: ExecutionOptions, deliver: (update: ConversationUpdate) => void): Promise<void> {
    let current: ExecutionContext<Readonly<Message>, GenerationOutput> | undefined;
    try {
      await this.submit(accept, options, (context) => {
        current = context;
        this.deliveries.set(context, deliver);
        deliver({ type: 'started', contextId: context.id, inputIndex: context.transcriptRange!.end - 1 });
      });
      deliver({ type: 'completed', contextId: current!.id });
    } finally {
      if (current) this.deliveries.delete(current);
    }
  }

  private readonly composition;

  readonly selection: SelectHistory;
  readonly generation: GenerateAnswer;
  readonly extraction: ExtractMemory;

  constructor(
    private readonly runtime: Runtime,
    provider: ModelProvider,
  ) {
    super(runtime.executionInvocations);
    this.selection = new SelectHistory(runtime, provider);
    this.generation = new GenerateAnswer(runtime, provider);
    this.extraction = new ExtractMemory(runtime, provider, this.runtime.context.memories);
    this.composition = new Sequence<ConversationInput, ObserverInvocation>()
      .step('selection', {
        use: this.selection,
        input: ({ input }) => input,
        accept: ({ parent }, selected) => {
          this.runtime.context.selectionUsage.add(selected.historyIndexes.map((index) => parent.context.transcriptRange!.read(index)));
          return selected;
        },
      })
      .step('generation', {
        use: this.generation,
        input: ({ input, outputs }) => ({ selection: outputs.selection, memories: input.memories }),
        accept: ({ parent }, answer) => {
          const context = parent.context;
          const transcript = context.transcriptRange!.transcript;
          const index = transcript.length;
          transcript.appendFrom([{ role: 'assistant', content: answer.content }], parent.source);
          this.deliveries.get(context)?.({ type: 'answer', contextId: context.id, index, output: answer });
          return { answer, response: transcript.ref(index) };
        },
      })
      .step('extraction', {
        use: this.extraction,
        input: ({ parent, input, outputs }) => prepareMemoryInput(parent.context.transcriptRange!, outputs.generation.response, outputs.selection.historyIndexes, input.memories),
      });
  }

  override submit(accept: () => Readonly<Message>, options: ExecutionOptions, started?: ExecutionStarted<Readonly<Message>, GenerationOutput>): Promise<GenerationOutput> {
    return super.submit(
      () => {
        const input = accept();
        if (!options.signal?.aborted) this.prepareSegment(input, options);
        return input;
      },
      options,
      started,
    );
  }

  private prepareSegment(message: Readonly<Message>, options: ExecutionOptions): void {
    const transcript = this.runtime.context.transcript;
    if (!transcript || transcript.get(transcript.length - 1) !== message) return;
    const range = new TranscriptRangeRef(transcript, transcript.activeStart, transcript.length);
    const input = { message, memories: this.runtime.context.memories.snapshot() };
    if (range.length <= 1 || this.selection.capacity(input, range, options.settings).fits) return;
    const next = segmentCandidates(range).find((candidate) => this.selection.capacity(input, candidate, options.settings).fits);
    // Do not accumulate empty segments when memory/current input alone cannot fit.
    if (next) transcript.startSegment(next.start);
  }

  protected async execute(context: ExecutionContext<Readonly<Message>, GenerationOutput>, invocation: Invocation<Readonly<Message>, GenerationOutput, ExecutionContext<Readonly<Message>, GenerationOutput>>): Promise<GenerationOutput> {
    const outputs = await this.composition.run(invocation, { message: context.currentInput, memories: this.runtime.context.memories.snapshot() });
    return outputs.generation.answer;
  }
}
