import { invocationRecording } from '@capix/server-runtime/recording';
import { MemoryResource } from '@capix/server-runtime/content';
import type { MemoryWriteResources } from '../../resources.js';
import { NodeDefinition, checkpointPoint, type NodeWork, type InvocationCheckpointDefinition } from '@capix/server-runtime';
import { checkpointCodec } from '../../checkpoint.js';
import { z } from 'zod';
import { memoryCheckpointOutput } from '../../group/memory/checkpoint.js';
import { checkLeafResult } from '../../group/checkpoint.js';
import type { MemoryExtraction } from '../../group/memory/output.js';

/** Apply already accepted changes; record each change after it takes effect. */
export class ApplyMemoryDefinition extends NodeDefinition<MemoryExtraction, MemoryExtraction, MemoryWriteResources> {
  readonly observation = [invocationRecording()];
  static readonly requires = Object.freeze({ memoryWriter: MemoryResource.apply.request() });
  readonly name = 'applyMemory';
  readonly label = '落实记忆';
  readonly source = 'services/observer/src/conversation/node/memory/apply.ts · ApplyMemoryDefinition';
  readonly callee = 'processing';
  private readonly preparedPoint = checkpointPoint<'node', MemoryExtraction, MemoryExtraction>()({ name: 'prepared', state: checkpointCodec(z.null()), references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { requires: ApplyMemoryDefinition.requires, execute: (work) => this.apply(work) } });
  readonly run = { requires: ApplyMemoryDefinition.requires, execute: this.execute.bind(this) };
  readonly checkpoint: InvocationCheckpointDefinition<MemoryExtraction, MemoryExtraction, 'node'> = { key: 'observer.apply-memory', version: 1, input: memoryCheckpointOutput, output: memoryCheckpointOutput, points: [this.preparedPoint] };

  private execute(work: NodeWork<MemoryExtraction, MemoryExtraction, MemoryWriteResources>): MemoryExtraction {
    work.checkpoint?.save(this.preparedPoint, null, {});
    return this.apply(work);
  }

  private apply(work: NodeWork<MemoryExtraction, MemoryExtraction, MemoryWriteResources>): MemoryExtraction {
    work.resources.memoryWriter.applyFixed({ position: 'memories', changes: work.input.memories });
    return work.input;
  }
}
