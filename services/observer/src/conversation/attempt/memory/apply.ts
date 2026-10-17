import { invocationRecording } from '@capix/server-runtime/recording';
import { MemoryResource } from '@capix/server-runtime/content';
import type { MemoryWriteResources } from '../../resources.js';
import { AttemptDefinition, checkpointPoint, type AttemptWork, type InvocationCheckpointDefinition } from '@capix/server-runtime';
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
  private readonly preparedPoint = checkpointPoint<'attempt', MemoryExtraction, MemoryExtraction>()({ name: 'prepared', state: checkpointCodec(z.null()), references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { requires: ApplyMemoryDefinition.requires, execute: (work) => this.apply(work) } });
  readonly run = { requires: ApplyMemoryDefinition.requires, execute: this.execute.bind(this) };
  readonly checkpoint: InvocationCheckpointDefinition<MemoryExtraction, MemoryExtraction, 'attempt'> = { key: 'observer.apply-memory', version: 1, input: memoryCheckpointOutput, output: memoryCheckpointOutput, points: [this.preparedPoint] };

  private execute(work: AttemptWork<MemoryExtraction, MemoryExtraction, MemoryWriteResources>): MemoryExtraction {
    work.checkpoint?.save(this.preparedPoint, null, {});
    return this.apply(work);
  }

  private apply(work: AttemptWork<MemoryExtraction, MemoryExtraction, MemoryWriteResources>): MemoryExtraction {
    work.resources.memoryWriter.applyFixed({ position: 'memories', changes: work.input.memories });
    return work.input;
  }
}
