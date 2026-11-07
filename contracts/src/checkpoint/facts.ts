import type { Stable } from '../value.js';
import type { ChildFacts } from '../children/facts.js';
import type { ContinuationFact } from './history.js';
import type { CheckpointReferenceSlots, SavedReferenceFacts } from './references.js';

export interface CheckpointFacts<Input, Slots extends CheckpointReferenceSlots = CheckpointReferenceSlots> {
  readonly initialInput: Stable<Input>;
  readonly input: Stable<Input>;
  readonly round: 1 | 2;
  readonly continuation?: ContinuationFact;
  readonly references: SavedReferenceFacts<Slots>;
  readonly children: ChildFacts;
}
