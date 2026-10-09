import { callRecording } from '@capix-observer/runtime';
import { RuntimeDefinition, type RuntimeScope, type InvocationView, type ChildBindings } from '@capix-observer/runtime';
import type { GenerationOutput } from '@capix-observer/protocol';
import { SelectHistory } from '../operations/history/select.js';
import { GenerateAnswer } from '../operations/answer/generate.js';
import { ExtractMemory } from '../operations/memory/extract.js';
import { ObserverExecutionDefinition } from './execution.js';

/** Business declarations contain no live environment or model provider. */
export class ObserverRuntimeDefinition extends RuntimeDefinition<unknown, GenerationOutput> {
  readonly observation = [callRecording()];
  readonly execution = new ObserverExecutionDefinition({ selection: new SelectHistory(), generation: new GenerateAnswer(), extraction: new ExtractMemory() });
  readonly children = [this.execution];
  readonly run = {
    requires: {},
    uses: this.children,
    execute: async (context: RuntimeScope<unknown, GenerationOutput>, invocation: InvocationView<unknown, GenerationOutput, RuntimeScope<unknown, GenerationOutput>>, children: ChildBindings): Promise<GenerationOutput> => {
      const child = children.get(this.execution).create(invocation, context.currentInput, { key: 'conversation' });
      const output = await child.run();
      return children.accept(child, () => output);
    },
  };
}
