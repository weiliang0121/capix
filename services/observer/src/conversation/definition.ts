import { invocationRecording } from '@capix/server-runtime/recording';
import { RuntimeDefinition, type RuntimeContextView, type InvocationView, type ChildBindings } from '@capix/server-runtime';
import type { GenerationOutput } from '@capix/protocol';
import { SelectHistoryDefinition } from './operations/history/select.js';
import { GenerateAnswerDefinition } from './operations/answer/generate.js';
import { ExtractMemoryDefinition } from './operations/memory/extract.js';
import { ConversationExecutionDefinition } from './execution.js';

/** Business declarations contain no live environment or model provider. */
export class ConversationRuntimeDefinition extends RuntimeDefinition<unknown, GenerationOutput> {
  readonly observation = [invocationRecording()];
  readonly executionDefinition = new ConversationExecutionDefinition({ selection: new SelectHistoryDefinition(), generation: new GenerateAnswerDefinition(), extraction: new ExtractMemoryDefinition() });
  readonly children = [this.executionDefinition];
  readonly run = {
    requires: {},
    uses: this.children,
    execute: async (context: RuntimeContextView<unknown, GenerationOutput>, invocation: InvocationView<unknown, GenerationOutput, RuntimeContextView<unknown, GenerationOutput>>, children: ChildBindings): Promise<GenerationOutput> => {
      const child = children.get(this.executionDefinition).create(invocation, context.currentInput, { key: 'conversation' });
      const output = await child.run();
      return children.accept(child, () => output);
    },
  };
}
