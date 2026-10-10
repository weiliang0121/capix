import { invocationRecording } from '@capix/server-runtime/recording';
import { MemoryResource } from '@capix/server-runtime/content';
import type { MemoryWriteResources } from '../../resources.js';
import { AttemptDefinition, type AttemptContextView } from '@capix/server-runtime';

import type { MemoryExtraction } from '../../operations/memory/output.js';

/** Apply already accepted changes; record each change after it takes effect. */
export class ApplyMemoryDefinition extends AttemptDefinition<MemoryExtraction, MemoryExtraction, MemoryWriteResources> {
  readonly observation = [invocationRecording()];
  static readonly requires = Object.freeze({ memoryWriter: MemoryResource.apply.request() });

  readonly name = 'applyMemory';
  readonly label = '落实记忆';
  readonly source = 'services/observer/src/conversation/attempt/memory/apply.ts · ApplyMemoryDefinition';
  readonly callee = 'processing';

  readonly run = { requires: ApplyMemoryDefinition.requires, execute: this.execute.bind(this) };

  private execute(context: AttemptContextView<MemoryExtraction, MemoryExtraction, MemoryWriteResources>): MemoryExtraction {
    context.resources.values.memoryWriter.apply(context.currentInput.memories);
    return context.currentInput;
  }
}
