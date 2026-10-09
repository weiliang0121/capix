import { ExecutionDefinition, Sequence, type InvocationView, type ExecutionScope, type ChildBindings } from '@capix-observer/runtime';
import type { Message, GenerationOutput } from '@capix-observer/protocol';
import { observerExecutionRequests, observerEntryRequests, type ObserverExecutionResources, type ObserverEntryResources } from './resources.js';
import { prepareMemoryInput, type MemoryInput } from '../operations/memory/input.js';
import type { SelectHistory } from '../operations/history/select.js';
import type { ExtractMemory } from '../operations/memory/extract.js';
import { acceptMessages } from './accept.js';
import { prepareObserverSegment } from './admission.js';
import type { GenerateAnswer } from '../operations/answer/generate.js';

type ObserverInvocation = InvocationView<Readonly<Message>, GenerationOutput, ExecutionScope<Readonly<Message>, GenerationOutput, ObserverExecutionResources>>;
export interface ObserverOperations {
  readonly selection: SelectHistory;
  readonly generation: GenerateAnswer;
  readonly extraction: ExtractMemory;
}

type ConversationInput = { message: Readonly<Message>; memories: MemoryInput['memories'] };

/** The fixed composition used by this experiment, reusable across calls. */
export class ObserverExecutionDefinition extends ExecutionDefinition<Readonly<Message>, GenerationOutput, ObserverExecutionResources, unknown, ObserverEntryResources> {
  readonly run;
  readonly entry = {
    requires: observerEntryRequests,
    accept: (input: unknown, resources: ObserverEntryResources) => acceptMessages(input, resources.messages.append),
    admit: prepareObserverSegment,
  };
  readonly children;
  private readonly composition;

  constructor(readonly operations: ObserverOperations) {
    super();
    this.children = Object.freeze(Object.values(operations));
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
          const response = context.resources.values.messages.append([{ role: 'assistant', content: answer.content }])[0]!;
          const index = response.index;
          context.resources.values.delivery({ type: 'answer', transcriptId: context.resources.values.history.transcriptId, contextId: context.id, index, output: answer });
          return { answer, response };
        },
      })
      .step('extraction', {
        use: operations.extraction,
        input: ({ parent, input, outputs }) => prepareMemoryInput(parent.context.resources.values.history, outputs.generation.response, outputs.selection.historyIndexes, input.memories),
      });
    this.run = { requires: observerExecutionRequests, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: ExecutionScope<Readonly<Message>, GenerationOutput, ObserverExecutionResources>, invocation: InvocationView<Readonly<Message>, GenerationOutput, ExecutionScope<Readonly<Message>, GenerationOutput, ObserverExecutionResources>>, children: ChildBindings): Promise<GenerationOutput> {
    const outputs = await this.composition.run(invocation, { message: context.currentInput, memories: context.resources.values.memories }, children);
    return outputs.generation.answer;
  }
}
