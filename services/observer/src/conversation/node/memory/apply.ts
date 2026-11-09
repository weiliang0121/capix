import { MemoryResource } from '@weiliang0121/capix-memory';
import type { MemoryWriteResources } from '../../resources.js';
import { Node, checkpointPoint, type NodeWork } from '@weiliang0121/capix-structure';
import { checkpointCodec } from '../../checkpoint.js';
import { z } from 'zod';
import { memoryCheckpointOutput } from '../../group/memory/checkpoint.js';
import { checkLeafResult } from '../../group/checkpoint.js';
import type { MemoryExtraction } from '../../group/memory/output.js';

/** Apply already accepted changes; record each change after it takes effect. */
export class ApplyMemory extends Node<MemoryExtraction, MemoryExtraction, MemoryWriteResources> {
  static readonly deps = Object.freeze({ memoryWriter: MemoryResource.apply.request() });

  private readonly preparedPoint;

  constructor() {
    super();

    this.preparedPoint = checkpointPoint<'node', MemoryExtraction, MemoryExtraction>()({ name: 'prepared', state: checkpointCodec(z.null()), references: {}, check: (_state, facts) => checkLeafResult(facts), resume: { deps: ApplyMemory.deps, run: (work) => this.apply(work) } });

    this.name = 'applyMemory';
    this.label = '落实记忆';
    this.source = 'services/observer/src/conversation/node/memory/apply.ts · ApplyMemory';
    this.deps = ApplyMemory.deps;
    this.run = this.execute.bind(this);
    this.checkpoint = { key: 'observer.apply-memory', version: 1, input: memoryCheckpointOutput, output: memoryCheckpointOutput, points: [this.preparedPoint] };
  }

  private execute(work: NodeWork<MemoryExtraction, MemoryExtraction, MemoryWriteResources>): MemoryExtraction {
    work.checkpoint?.({ point: this.preparedPoint, state: null, refs: {} });
    return this.apply(work);
  }

  private apply(work: NodeWork<MemoryExtraction, MemoryExtraction, MemoryWriteResources>): MemoryExtraction {
    work.resources.memoryWriter.applyFixed({ position: 'memories', changes: work.input.memories });
    return work.input;
  }
}
