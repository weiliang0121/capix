import { MemoryResource } from '@weiliang0121/capix-memory';
import type { ResourcesOf } from '@weiliang0121/capix-resources';
import { Node, checkpointPoint } from '@weiliang0121/capix-structure';
import { voidCodec } from '../recovery/codecs.js';
import { memoryApplyCodec, memoryIdsCodec, type MemoryMaintenanceApply } from './codecs.js';

export const memoryApplyCheckpointKey = 'conversation.memory.apply';
export const memoryApplyPosition = 'memory-maintenance';

/** The receipt and its original basis belong to this exact child invocation. */
export function createMemoryApplication() {
  const deps = { memories: MemoryResource.apply.request() };
  type Access = ResourcesOf<typeof deps>;
  function apply(resources: Access, input: MemoryMaintenanceApply, fixed: boolean): readonly string[] {
    const ids = fixed ? resources.memories.applyFixed({ position: memoryApplyPosition, changes: input.changes }, input.basis).memoryIds : resources.memories.apply(input.changes, input.basis).items.map((item) => item.id);
    const existing = new Set(input.existingIds);
    return Object.freeze(ids.filter((id) => !existing.has(id)));
  }
  const completed = checkpointPoint<'node', MemoryMaintenanceApply, readonly string[]>()({ name: 'completed', state: memoryIdsCodec, references: {}, resume: { run: (_work, state) => state } });
  const prepared = checkpointPoint<'node', MemoryMaintenanceApply, readonly string[]>()({
    name: 'prepared',
    state: voidCodec,
    references: {},
    resume: {
      deps,
      run(work) {
        const ids = apply(work.resources, work.input, true);
        work.checkpoint?.({ point: completed, state: ids, refs: {} });
        return ids;
      },
    },
  });
  return new Node<MemoryMaintenanceApply, readonly string[], Access>({
    name: 'apply-conversation-memories',
    deps,
    checkpoint: { key: memoryApplyCheckpointKey, version: 1, input: memoryApplyCodec, output: memoryIdsCodec, points: [prepared, completed] },
    run(work) {
      work.checkpoint?.({ point: prepared, state: undefined, refs: {} });
      const ids = apply(work.resources, work.input, work.checkpoint !== undefined);
      work.checkpoint?.({ point: completed, state: ids, refs: {} });
      return ids;
    },
  });
}
