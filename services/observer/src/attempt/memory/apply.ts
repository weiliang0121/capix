import { MemoryResource } from '@capix-observer/runtime';
import type { MemoryWriteResources } from '../../observer/resources.js';
import { AttemptDefinition, type AttemptScope } from '@capix-observer/runtime';

import type { MemoryExtraction } from '../../operations/memory/output.js';

/** Apply already accepted changes; record each change after it takes effect. */
export class ApplyMemory extends AttemptDefinition<MemoryExtraction, MemoryExtraction, MemoryWriteResources> {
  static readonly requires = Object.freeze({ memoryWriter: MemoryResource.apply.request() });

  readonly name = 'applyMemory';
  readonly label = '落实记忆';
  readonly source = 'services/observer/src/attempt/memory/apply.ts · ApplyMemory';
  readonly callee = 'processing';

  readonly run = { requires: ApplyMemory.requires, execute: this.execute.bind(this) };

  private execute(context: AttemptScope<MemoryExtraction, MemoryExtraction, MemoryWriteResources>): MemoryExtraction {
    context.resources.values.memoryWriter.apply(context.currentInput.memories);
    return context.currentInput;
  }
}
