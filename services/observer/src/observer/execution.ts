import { ExecutionDefinition, Sequence, type Invocation, type ExecutionContext, type ChildBindings } from '@capix-observer/runtime';
import type { Message, GenerationOutput } from '@capix-observer/protocol';
import { observerExecutionRequests, type ObserverExecutionResources } from './resources.js';
import { prepareMemoryInput, type MemoryInput } from '../operations/memory/input.js';
import type { SelectHistory } from '../operations/history/select.js';
import type { ExtractMemory } from '../operations/memory/extract.js';
import type { GenerateAnswer } from '../operations/answer/generate.js';

type ObserverInvocation = Invocation<Readonly<Message>, GenerationOutput, ExecutionContext<Readonly<Message>, GenerationOutput, ObserverExecutionResources>>;
export interface ObserverOperations {
  readonly selection: SelectHistory;
  readonly generation: GenerateAnswer;
  readonly extraction: ExtractMemory;
}

type ConversationInput = { message: Readonly<Message>; memories: MemoryInput['memories'] };

/** The fixed composition used by this experiment, reusable across calls. */
export class ObserverExecutionDefinition extends ExecutionDefinition<Readonly<Message>, GenerationOutput, ObserverExecutionResources> {
  readonly requires = observerExecutionRequests;
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
          const response = context.resources.values.messages.append([{ role: 'assistant', content: answer.content }], parent.source)[0]!;
          const index = response.index;
          context.resources.values.delivery({ type: 'answer', contextId: context.id, index, output: answer });
          return { answer, response };
        },
      })
      .step('extraction', {
        use: operations.extraction,
        input: ({ parent, input, outputs }) => prepareMemoryInput(parent.context.resources.values.history, outputs.generation.response, outputs.selection.historyIndexes, input.memories),
      });
  }

  async execute(context: ExecutionContext<Readonly<Message>, GenerationOutput, ObserverExecutionResources>, invocation: Invocation<Readonly<Message>, GenerationOutput, ExecutionContext<Readonly<Message>, GenerationOutput, ObserverExecutionResources>>, children: ChildBindings): Promise<GenerationOutput> {
    const outputs = await this.composition.run(invocation, { message: context.currentInput, memories: context.resources.values.memories }, children);
    return outputs.generation.answer;
  }
}
