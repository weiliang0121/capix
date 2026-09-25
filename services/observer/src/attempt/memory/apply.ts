import { Attempt, type AttemptContext, type Runtime, type MemoryCollection, MemoryHelper, MemoryRecordHelper } from '@capix-observer/runtime';

import type { MemoryExtraction } from '../../operations/memory/output.js';

/** Apply already accepted changes; record each change after it takes effect. */
export class ApplyMemory extends Attempt<MemoryExtraction, MemoryExtraction> {
  readonly name = 'applyMemory';
  readonly label = '落实记忆';
  readonly source = 'services/observer/src/attempt/memory/apply.ts · ApplyMemory';
  readonly callee = 'processing';

  constructor(
    runtime: Runtime,
    private readonly memories: MemoryCollection,
  ) {
    super(runtime);
  }

  protected execute(context: AttemptContext<MemoryExtraction, MemoryExtraction>): MemoryExtraction {
    const operation = this.runtime.getOperationContext(context);
    const transcript = operation.executionContext.transcriptRange!.transcript;
    const recorder = this.runtime.recorder;
    MemoryHelper.apply(this.memories, transcript, context.currentInput.memories, recorder ? (memory, change) => MemoryRecordHelper.capture(recorder, operation, memory, change) : undefined);
    return context.currentInput;
  }
}
