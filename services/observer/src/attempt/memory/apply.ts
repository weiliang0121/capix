import { Attempt, type AttemptContext, type Runtime, type Memories } from '@capix-observer/runtime';

import type { MemoryExtraction } from '../../operations/memory/output.js';

/** Apply already accepted changes; record each change after it takes effect. */
export class ApplyMemory extends Attempt<MemoryExtraction, MemoryExtraction> {
  readonly name = 'applyMemory';
  readonly label = '落实记忆';
  readonly source = 'services/observer/src/attempt/memory/apply.ts · ApplyMemory';
  readonly callee = 'processing';

  constructor(
    runtime: Runtime,
    private readonly memories: Memories,
  ) {
    super(runtime);
  }

  protected execute(context: AttemptContext<MemoryExtraction, MemoryExtraction>): MemoryExtraction {
    context.requireRunning();
    context.operationContext.requireRunning();
    context.operationContext.executionContext.requireRunning();
    this.memories.apply(context.currentInput.memories, { contextId: context.id });
    return context.currentInput;
  }
}
