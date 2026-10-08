import { MemoryResource } from '@capix-observer/runtime';
import type { MemoryWriteResources } from '../../observer/resources.js';
import type { Invocation } from '@capix-observer/runtime';
import { AttemptDefinition, type AttemptContext } from '@capix-observer/runtime';

import type { MemoryExtraction } from '../../operations/memory/output.js';

/** Apply already accepted changes; record each change after it takes effect. */
export class ApplyMemory extends AttemptDefinition<MemoryExtraction, MemoryExtraction, MemoryWriteResources> {
  static readonly requires = Object.freeze({ memoryWriter: MemoryResource.apply.request() });

  readonly name = 'applyMemory';
  readonly label = '落实记忆';
  readonly source = 'services/observer/src/attempt/memory/apply.ts · ApplyMemory';
  readonly callee = 'processing';

  readonly requires = ApplyMemory.requires;

  execute(context: AttemptContext<MemoryExtraction, MemoryExtraction, MemoryWriteResources>, invocation: Invocation<MemoryExtraction, MemoryExtraction, AttemptContext<MemoryExtraction, MemoryExtraction, MemoryWriteResources>>): MemoryExtraction {
    context.resources.values.memoryWriter.apply(context.currentInput.memories, invocation.source);
    return context.currentInput;
  }
}
