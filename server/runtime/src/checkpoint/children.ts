import { isEqual } from 'es-toolkit';
import type { CheckpointChild, CheckpointHead } from './contract.js';
import { cloneCheckpointHead } from './value.js';

/** Interpret saved evidence only; installing a target and its relationship belongs to the parent call. */
export function resolveCheckpointChild(saved: CheckpointChild, value?: CheckpointHead): { readonly kind: 'continuation' } | { readonly kind: 'delivery'; readonly child: CheckpointChild } {
  if (saved.state.kind === 'failed') throw new Error('Historical failed child cannot be resumed');
  if (saved.state.kind !== 'waiting') return { kind: 'delivery', child: saved };
  if (!value) throw new Error('Waiting child has no durable continuation; execution is unknown');
  const head = cloneCheckpointHead(value);
  if (!isEqual(head.image.frame.owner, saved.identity) || !isEqual(head.image.frame.input, saved.input) || !isEqual(head.image.contract, saved.contract)) throw new Error('Child checkpoint differs from parent-owned identity');
  if (!head.delivery) return { kind: 'continuation' };
  if (head.delivery.status !== 'succeeded') throw new Error('Failed or cancelled child cannot be resumed');
  return { kind: 'delivery', child: { ...saved, state: { kind: 'returned', output: head.delivery.output, progress: head.delivery.progress, reception: { kind: 'pending' } } } };
}
