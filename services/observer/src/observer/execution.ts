import { checkResourceRequests } from '@capix-observer/runtime';
import { observerExecutionRequests, type ObserverExecutionResources, type ObserverResourceBindings } from './resources.js';
import { Sequence } from '@capix-observer/runtime';
import type { MemoryInput } from '../operations/memory/input.js';
import type { Invocation, ExecutionStarted } from '@capix-observer/runtime';
import { Execution, type ExecutionContext, type ExecutionOptions, type ExecutionInvocationBuilder, type BehaviorInitializer } from '@capix-observer/runtime';

import type { Message, GenerationOutput, ConversationUpdate } from '@capix-observer/protocol';

import { selectionCapacity, type SelectHistory } from '../operations/history/select.js';

import type { ExtractMemory } from '../operations/memory/extract.js';
import { prepareMemoryInput } from '../operations/memory/input.js';

import type { GenerateAnswer } from '../operations/answer/generate.js';
import { segmentCandidates } from './segment.js';

type ObserverInvocation = Invocation<Readonly<Message>, GenerationOutput, ExecutionContext<Readonly<Message>, GenerationOutput, ObserverExecutionResources>>;
export interface ObserverOperations {
  readonly selection: BehaviorInitializer<SelectHistory>;
  readonly generation: BehaviorInitializer<GenerateAnswer>;
  readonly extraction: BehaviorInitializer<ExtractMemory>;
}

type ConversationInput = { message: Readonly<Message>; memories: MemoryInput['memories'] };

/** The fixed composition used by this experiment, reusable across calls. */
export class ObserverExecution extends Execution<Readonly<Message>, GenerationOutput, ObserverExecutionResources> {
  private readonly deliveries = new WeakMap<ExecutionContext<Readonly<Message>, GenerationOutput, ObserverExecutionResources>, (update: ConversationUpdate) => void>();

  async converse(accept: () => Readonly<Message>, options: ExecutionOptions, deliver: (update: ConversationUpdate) => void): Promise<void> {
    let current: ExecutionContext<Readonly<Message>, GenerationOutput, ObserverExecutionResources> | undefined;
    try {
      await this.submit(accept, options, (context) => {
        current = context;
        this.deliveries.set(context, deliver);
        deliver({ type: 'started', contextId: context.id, inputIndex: context.resources.values.history.end - 1 });
      });
      deliver({ type: 'completed', contextId: current!.id });
    } finally {
      if (current) this.deliveries.delete(current);
    }
  }

  readonly requires = observerExecutionRequests;
  private readonly entryResources: ObserverResourceBindings['entry'];
  private readonly composition;

  constructor(
    invocations: ExecutionInvocationBuilder,
    readonly operations: ObserverOperations,
    bindings: ObserverResourceBindings,
  ) {
    super(invocations);
    this.resourceBinding = bindings.execution;
    this.entryResources = bindings.entry;
    this.composition = new Sequence<ConversationInput, ObserverInvocation>()
      .step('selection', {
        use: operations.selection,
        input: ({ input }) => input,
        accept: ({ parent }, selected) => {
          parent.context.resources.values.selectionUsage.add(selected.historyIndexes.map((index) => parent.context.resources.values.history.read(index)));
          return selected;
        },
      })
      .step('generation', {
        use: operations.generation,
        input: ({ input, outputs }) => ({ selection: outputs.selection, memories: input.memories }),
        accept: ({ parent }, answer) => {
          const context = parent.context;
          const response = context.resources.values.messages.append([{ role: 'assistant', content: answer.content }], parent.source)[0]!;
          const index = response.index;
          this.deliveries.get(context)?.({ type: 'answer', contextId: context.id, index, output: answer });
          return { answer, response };
        },
      })
      .step('extraction', {
        use: operations.extraction,
        input: ({ parent, input, outputs }) => prepareMemoryInput(parent.context.resources.values.history, outputs.generation.response, outputs.selection.historyIndexes, input.memories),
      });
    checkResourceRequests(this.requires, this.composition.requests);
  }

  override submit(accept: () => Readonly<Message>, options: ExecutionOptions, started?: ExecutionStarted<Readonly<Message>, GenerationOutput, ObserverExecutionResources>): Promise<GenerationOutput> {
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
    const { segmentation, memories, settings } = this.entryResources({ settings: options.settings }).values;
    const range = segmentation.current();
    if (range.length === 0 || range.read(range.end - 1) !== message) return;
    const input = { message, memories };
    if (range.length <= 1 || selectionCapacity(input, range, settings).fits) return;
    const next = segmentCandidates(range).find((candidate) => selectionCapacity(input, candidate, settings).fits);
    // Do not accumulate empty segments when memory/current input alone cannot fit.
    if (next) segmentation.start(next.start);
  }

  protected async execute(context: ExecutionContext<Readonly<Message>, GenerationOutput, ObserverExecutionResources>, invocation: Invocation<Readonly<Message>, GenerationOutput, ExecutionContext<Readonly<Message>, GenerationOutput, ObserverExecutionResources>>): Promise<GenerationOutput> {
    const outputs = await this.composition.run(invocation, { message: context.currentInput, memories: context.resources.values.memories });
    return outputs.generation.answer;
  }
}
