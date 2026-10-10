import { invocationRecording } from '@capix/server-runtime/recording';
import { ExecutionDefinition, Sequence, type InvocationView, type ExecutionContextView, type ChildBindings } from '@capix/server-runtime';
import type { Message, GenerationOutput } from '@capix/protocol';
import { conversationExecutionRequests, conversationEntryRequests, type ConversationExecutionResources, type ConversationEntryResources } from './resources.js';
import { prepareMemoryInput, type MemoryInput } from './operations/memory/input.js';
import type { SelectHistoryDefinition } from './operations/history/select.js';
import type { ExtractMemoryDefinition } from './operations/memory/extract.js';
import { acceptMessages } from './accept.js';
import { prepareConversationSegment } from './admission.js';
import type { GenerateAnswerDefinition } from './operations/answer/generate.js';

type ConversationExecutionInvocationView = InvocationView<Readonly<Message>, GenerationOutput, ExecutionContextView<Readonly<Message>, GenerationOutput, ConversationExecutionResources>>;
export interface ConversationOperationDefinitions {
  readonly selection: SelectHistoryDefinition;
  readonly generation: GenerateAnswerDefinition;
  readonly extraction: ExtractMemoryDefinition;
}

type ConversationSequenceInput = { message: Readonly<Message>; memories: MemoryInput['memories'] };

/** The reference conversation composition, reusable across calls. */
export class ConversationExecutionDefinition extends ExecutionDefinition<Readonly<Message>, GenerationOutput, ConversationExecutionResources, unknown, ConversationEntryResources> {
  readonly observation = [invocationRecording()];
  readonly run;
  readonly entry = {
    requires: conversationEntryRequests,
    accept: (input: unknown, resources: ConversationEntryResources) => acceptMessages(input, resources.messages.append),
    admit: prepareConversationSegment,
  };
  readonly children;
  private readonly composition;

  constructor(readonly operationDefinitions: ConversationOperationDefinitions) {
    super();
    this.children = Object.freeze(Object.values(operationDefinitions));
    this.composition = new Sequence<ConversationSequenceInput, ConversationExecutionInvocationView>()
      .step('selection', {
        use: operationDefinitions.selection,
        input: ({ input }) => input,
        accept: ({ parent }, selected) => {
          parent.context.resources.values.selectionUsage.add(selected.historyIndexes.map((index) => parent.context.resources.values.history.read(index)));
          return selected;
        },
      })
      .step('generation', {
        use: operationDefinitions.generation,
        input: ({ input, outputs }) => ({ selection: outputs.selection, memories: input.memories }),
        accept: ({ parent }, answer) => {
          const context = parent.context;
          const response = context.resources.values.messages.append([{ role: 'assistant', content: answer.content }])[0]!;
          return { answer, response };
        },
      })
      .step('extraction', {
        use: operationDefinitions.extraction,
        input: ({ parent, input, outputs }) => prepareMemoryInput(parent.context.resources.values.history, outputs.generation.response, outputs.selection.historyIndexes, input.memories),
      });
    this.run = { requires: conversationExecutionRequests, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: ExecutionContextView<Readonly<Message>, GenerationOutput, ConversationExecutionResources>, invocation: InvocationView<Readonly<Message>, GenerationOutput, ExecutionContextView<Readonly<Message>, GenerationOutput, ConversationExecutionResources>>, children: ChildBindings): Promise<GenerationOutput> {
    const outputs = await this.composition.run(invocation, { message: context.currentInput, memories: context.resources.values.memories }, children);
    return outputs.generation.answer;
  }
}
