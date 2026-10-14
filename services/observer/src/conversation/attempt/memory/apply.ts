import { invocationRecording } from '@capix/server-runtime/recording';
import { MemoryResource } from '@capix/server-runtime/content';
import type { MemoryWriteResources } from '../../resources.js';
import { AttemptDefinition, type AttemptContextView, type InvocationWorkView, type InvocationCheckpointDefinition } from '@capix/server-runtime';
import { checkpointCodec } from '../../checkpoint.js';
import { z } from 'zod';
import { memoryCheckpointOutput } from '../../operations/memory/checkpoint.js';
import { checkLeafResult } from '../../operations/checkpoint.js';

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
  readonly checkpoint: InvocationCheckpointDefinition<MemoryExtraction, MemoryExtraction, AttemptContextView<MemoryExtraction, MemoryExtraction, MemoryWriteResources>> = {
    key: 'observer.apply-memory',
    version: 1,
    input: memoryCheckpointOutput,
    output: memoryCheckpointOutput,
    points: { prepared: { state: checkpointCodec(z.null()), check: checkLeafResult, resume: { requires: ApplyMemoryDefinition.requires, uses: [], execute: (context) => this.apply(context) } } },
  };

  private execute(context: AttemptContextView<MemoryExtraction, MemoryExtraction, MemoryWriteResources>, invocation: InvocationWorkView<MemoryExtraction, MemoryExtraction, AttemptContextView<MemoryExtraction, MemoryExtraction, MemoryWriteResources>>): MemoryExtraction {
    invocation.checkpoint?.save('prepared', null);
    return this.apply(context);
  }

  private apply(context: AttemptContextView<MemoryExtraction, MemoryExtraction, MemoryWriteResources>): MemoryExtraction {
    context.resources.values.memoryWriter.applyFixed({ position: 'memories', changes: context.currentInput.memories });
    return context.currentInput;
  }
}
