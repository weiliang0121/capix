import { createHash } from 'node:crypto';
import { isEqual } from 'es-toolkit';
import type { CheckpointCommit, CheckpointReference, CheckpointReferences, CheckpointSelectionChange, CheckpointSelectionReference, CheckpointSelectionSlots, CheckpointSelectionSnapshot, CheckpointChildRecord } from './contract.js';
import { checkpointMetrics, encodeCheckpointData, type CheckpointValueMetrics } from './encoding.js';

export interface CheckpointStoredSelection extends CheckpointSelectionReference {
  readonly owner: string;
  readonly nextOrder: number;
  readonly count: number;
  readonly bytes: number;
  readonly nodes: number;
  readonly sum: string;
  readonly digest: string;
}
export interface CheckpointStoredOccurrence {
  readonly id: string;
  readonly order: number;
  /** Missing only for a retired occurrence identity. */
  readonly reference?: CheckpointReference;
}
export interface CheckpointSelectionReader {
  selection(id: string): CheckpointStoredSelection | undefined;
  occurrence(selection: string, id: string): CheckpointStoredOccurrence | undefined;
}
export interface CheckpointSelectionPlan {
  readonly head: CheckpointStoredSelection;
  readonly reset: boolean;
  readonly remove: readonly string[];
  readonly append: readonly CheckpointStoredOccurrence[];
}

const zero = '0'.repeat(64);
const mask = (1n << 256n) - 1n;
const hash = (value: unknown) =>
  createHash('sha256')
    .update(encodeCheckpointData(canonical(value)))
    .digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}
const digest = ({ digest: _digest, ...value }: CheckpointStoredSelection) => hash(value);
const add = (sum: string, term: string, direction: 1 | -1) => ((BigInt(`0x${sum}`) + BigInt(direction) * BigInt(`0x${term}`)) & mask).toString(16).padStart(64, '0');

export function isCheckpointSelectionSlots(value: CheckpointCommit['references']): value is CheckpointSelectionSlots {
  return 'kind' in value && value.kind === 'slots';
}

export function checkpointSelectionReferences(value: CheckpointSelectionSlots): readonly CheckpointSelectionReference[] {
  exact(value, ['kind', 'slots']);
  if (!value.slots || typeof value.slots !== 'object' || Array.isArray(value.slots)) throw new Error('Invalid checkpoint selection slots');
  const result = new Map<string, CheckpointSelectionReference>();
  for (const slot of Object.values(value.slots)) {
    if (slot.kind === 'one') {
      exact(slot, ['kind', 'reference']);
      validateReference(slot.reference);
    } else if (slot.kind === 'many') {
      exact(slot, ['kind', 'selection']);
      const reference = slot.selection;
      exact(reference, ['id', 'revision', 'target']);
      identity(reference.id);
      integer(reference.revision, 1);
      target(reference.target);
      const previous = result.get(reference.id);
      if (previous && !isEqual(previous, reference)) throw new Error('One selection cannot name different revisions or positions');
      result.set(reference.id, reference);
    } else throw new Error('Invalid checkpoint selection slot');
  }
  return [...result.values()];
}

/** A commutative sum of position-bound SHA-256 terms, not a signature or authorization. */
function occurrenceDigest(selection: Pick<CheckpointStoredSelection, 'owner' | 'id' | 'target'>, occurrence: CheckpointStoredOccurrence): string {
  return hash({ owner: selection.owner, selection: selection.id, target: selection.target, occurrence });
}

export function checkCheckpointStoredSelection(value: CheckpointStoredSelection, owner: string, id: string): void {
  exact(value, ['owner', 'id', 'target', 'revision', 'nextOrder', 'count', 'bytes', 'nodes', 'sum', 'digest']);
  if (value.owner !== owner || value.id !== id) throw new Error('Checkpoint selection owner or identity differs');
  identity(id);
  target(value.target);
  integer(value.revision, 1);
  for (const item of [value.nextOrder, value.count, value.bytes, value.nodes]) integer(item, 0);
  if (value.count > value.nextOrder || !/^[a-f0-9]{64}$/.test(value.sum) || value.digest !== digest(value)) throw new Error('Checkpoint selection aggregate differs');
}

export function prepareCheckpointSelections(commit: CheckpointCommit, reader: CheckpointSelectionReader, child: (id: string) => CheckpointChildRecord | undefined): { readonly plans: readonly CheckpointSelectionPlan[]; readonly metrics: CheckpointValueMetrics } | undefined {
  if (!isCheckpointSelectionSlots(commit.references)) {
    if (commit.selectionChanges?.length) throw new Error('Selection changes require explicit selection slots');
    return undefined;
  }
  const owner = commit.frame.owner.contextId;
  const selected = checkpointSelectionReferences(commit.references);
  const changes = new Map<string, CheckpointSelectionChange>();
  for (const change of commit.selectionChanges ?? []) {
    exact(change, ['id', 'target', 'expectedRevision'], ['reset', 'append', 'remove']);
    identity(change.id);
    target(change.target);
    integer(change.expectedRevision, 0);
    if (change.reset !== undefined && change.reset !== true) throw new Error('Invalid checkpoint selection reset');
    if (changes.has(change.id)) throw new Error('Duplicate checkpoint selection change');
    if (change.reset && change.remove?.length) throw new Error('A selection reset cannot also remove individual occurrences');
    changes.set(change.id, change);
  }
  const installed = new Map<string, CheckpointStoredSelection>();
  const plans: CheckpointSelectionPlan[] = [];
  for (const selection of selected) {
    const previous = reader.selection(selection.id);
    if (previous) {
      checkCheckpointStoredSelection(previous, owner, selection.id);
      if (!isEqual(previous.target, selection.target)) throw new Error('Checkpoint selection position cannot change');
    }
    const change = changes.get(selection.id);
    if (!change) {
      if (!previous || previous.revision !== selection.revision) throw new Error('Checkpoint selection revision is unavailable');
      installed.set(selection.id, previous);
      continue;
    }
    if (change.expectedRevision !== (previous?.revision ?? 0) || selection.revision !== change.expectedRevision + 1 || !isEqual(change.target, selection.target)) throw new Error('Checkpoint selection revision or position conflicts');
    integer(selection.revision, 1);
    let count = change.reset ? 0 : (previous?.count ?? 0);
    let bytes = change.reset ? 0 : (previous?.bytes ?? 0);
    let nodes = change.reset ? 0 : (previous?.nodes ?? 0);
    let sum = change.reset ? zero : (previous?.sum ?? zero);
    let nextOrder = previous?.nextOrder ?? 0;
    const basis = { owner, id: selection.id, target: selection.target };
    const removed = new Set<string>();
    for (const removal of change.remove ?? []) {
      exact(removal, ['id', 'order', 'reference']);
      const id = removal.id;
      identity(id);
      integer(removal.order, 0);
      validateReference(removal.reference);
      if (removed.has(id)) throw new Error('Duplicate removed checkpoint occurrence');
      const occurrence = reader.occurrence(selection.id, id);
      if (!occurrence?.reference) throw new Error('Checkpoint occurrence is missing or already removed');
      validateOccurrence(occurrence);
      if (occurrence.id !== id || occurrence.order !== removal.order || occurrence.order >= nextOrder || !isEqual(occurrence.reference, removal.reference)) throw new Error('Checkpoint occurrence identity, order or value differs');
      const metrics = checkpointMetrics(occurrence.reference);
      count--;
      bytes -= metrics.bytes;
      nodes -= metrics.nodes;
      sum = add(sum, occurrenceDigest(basis, occurrence), -1);
      removed.add(id);
    }
    const appended = new Map<string, CheckpointStoredOccurrence>();
    for (const item of change.append ?? []) {
      exact(item, ['id', 'reference']);
      identity(item.id);
      validateReference(item.reference);
      if (appended.has(item.id) || reader.occurrence(selection.id, item.id)) throw new Error('Checkpoint occurrence identity is already reserved');
      authenticateCheckpointReference(item.reference, child);
      if (item.reference.parentContextId !== owner || item.reference.parentRound !== commit.frame.round || !isEqual(item.reference.target, selection.target)) throw new Error('Checkpoint selection reference belongs to a different scope or position');
      integer(nextOrder + 1, 1);
      const occurrence = Object.freeze({ id: item.id, order: nextOrder++, reference: item.reference });
      const metrics = checkpointMetrics(item.reference);
      count++;
      bytes += metrics.bytes;
      nodes += metrics.nodes;
      sum = add(sum, occurrenceDigest(basis, occurrence), 1);
      appended.set(item.id, occurrence);
    }
    if (count < 0 || bytes < 0 || nodes < 0 || (count === 0 && (bytes !== 0 || nodes !== 0 || sum !== zero))) throw new Error('Checkpoint selection accounting differs');
    const candidate = { ...basis, revision: selection.revision, nextOrder, count, bytes, nodes, sum, digest: '' };
    const head = Object.freeze({ ...candidate, digest: digest(candidate) });
    checkCheckpointStoredSelection(head, owner, selection.id);
    installed.set(selection.id, head);
    plans.push({ head, reset: !!change.reset, remove: [...removed], append: [...appended.values()] });
    changes.delete(selection.id);
  }
  if (changes.size) throw new Error('Unselected checkpoint selection changes cannot be committed');
  const skeleton: Record<string, unknown> = Object.create(null);
  const markers = new Map<object, CheckpointValueMetrics>();
  for (const [name, slot] of Object.entries(commit.references.slots)) {
    if (slot.kind === 'one') {
      authenticateCheckpointReference(slot.reference, child);
      skeleton[name] = slot.reference;
    } else {
      const selection = installed.get(slot.selection.id)!;
      const array: readonly unknown[] = [];
      skeleton[name] = array;
      markers.set(array, { bytes: 2 + selection.bytes + Math.max(0, selection.count - 1), nodes: 1 + selection.nodes, depth: selection.count ? 3 : 0 });
    }
  }
  return { plans, metrics: checkpointMetrics(skeleton, (value) => markers.get(value)) };
}

/** Cold reads validate every reserved order and all current occurrence bodies. */
export function materializeCheckpointSelections(slots: CheckpointSelectionSlots, owner: string, selections: readonly { readonly head: CheckpointStoredSelection; readonly occurrences: readonly CheckpointStoredOccurrence[] }[]): { readonly references: CheckpointReferences; readonly snapshots: readonly CheckpointSelectionSnapshot[] } {
  const byId = new Map(selections.map((item) => [item.head.id, item]));
  if (byId.size !== selections.length) throw new Error('Duplicate persisted selection');
  const snapshots: CheckpointSelectionSnapshot[] = [];
  const contents = new Map<string, readonly CheckpointReference[]>();
  for (const selected of checkpointSelectionReferences(slots)) {
    const item = byId.get(selected.id);
    if (!item) throw new Error('Missing persisted checkpoint selection');
    checkCheckpointStoredSelection(item.head, owner, selected.id);
    if (item.head.revision !== selected.revision || !isEqual(item.head.target, selected.target)) throw new Error('Persisted checkpoint selection revision differs');
    const all = [...item.occurrences].sort((a, b) => a.order - b.order);
    if (all.length !== item.head.nextOrder || new Set(all.map((value) => value.id)).size !== all.length) throw new Error('Persisted checkpoint occurrence identities differ');
    const live: Required<CheckpointStoredOccurrence>[] = [];
    all.forEach((value, index) => {
      validateOccurrence(value);
      if (value.order !== index) throw new Error('Persisted checkpoint occurrence order is incomplete');
      if (value.reference) live.push(value as Required<CheckpointStoredOccurrence>);
    });
    const snapshot = Object.freeze({ ...item.head, occurrences: Object.freeze(live) });
    checkCheckpointSelectionSnapshot(snapshot, owner);
    snapshots.push(snapshot);
    contents.set(selected.id, Object.freeze(live.map(({ reference }) => reference)));
    byId.delete(selected.id);
  }
  if (byId.size) throw new Error('Unexpected unselected checkpoint material');
  return { references: projectReferences(slots, contents), snapshots: Object.freeze(snapshots) };
}

export function checkCheckpointSelectionSnapshot(snapshot: CheckpointSelectionSnapshot, owner: string): void {
  const { occurrences, ...head } = snapshot;
  checkCheckpointStoredSelection(head, owner, snapshot.id);
  if (!Array.isArray(occurrences) || occurrences.length !== snapshot.count) throw new Error('Checkpoint selection snapshot count differs');
  let bytes = 0;
  let nodes = 0;
  let sum = zero;
  let order = -1;
  const ids = new Set<string>();
  for (const occurrence of occurrences) {
    validateOccurrence(occurrence);
    if (!occurrence.reference || occurrence.order <= order || occurrence.order >= snapshot.nextOrder || ids.has(occurrence.id) || occurrence.reference.parentContextId !== owner || !isEqual(occurrence.reference.target, snapshot.target)) throw new Error('Checkpoint selection snapshot occurrence differs');
    order = occurrence.order;
    ids.add(occurrence.id);
    const metrics = checkpointMetrics(occurrence.reference);
    bytes += metrics.bytes;
    nodes += metrics.nodes;
    sum = add(sum, occurrenceDigest(snapshot, occurrence), 1);
  }
  if (bytes !== snapshot.bytes || nodes !== snapshot.nodes || sum !== snapshot.sum) throw new Error('Checkpoint selection snapshot aggregate differs');
}

export function checkpointSnapshotReferences(slots: CheckpointSelectionSlots, owner: string, snapshots: readonly CheckpointSelectionSnapshot[]): CheckpointReferences {
  const selected = checkpointSelectionReferences(slots);
  const values = new Map<string, readonly CheckpointReference[]>();
  if (selected.length !== snapshots.length) throw new Error('Checkpoint selection publication differs');
  for (const item of snapshots) {
    checkCheckpointSelectionSnapshot(item, owner);
    const reference = selected.find((entry) => entry.id === item.id);
    if (!reference || reference.revision !== item.revision || !isEqual(reference.target, item.target) || values.has(item.id)) throw new Error('Checkpoint selection publication identity differs');
    values.set(
      item.id,
      item.occurrences.map(({ reference }) => reference),
    );
  }
  return projectReferences(slots, values);
}

function projectReferences(slots: CheckpointSelectionSlots, contents: ReadonlyMap<string, readonly CheckpointReference[]>): CheckpointReferences {
  return Object.freeze(Object.fromEntries(Object.entries(slots.slots).map(([name, slot]) => [name, slot.kind === 'one' ? slot.reference : contents.get(slot.selection.id)!])));
}
function validateOccurrence(value: CheckpointStoredOccurrence): void {
  exact(value, ['id', 'order'], ['reference']);
  identity(value.id);
  integer(value.order, 0);
  if (value.reference) validateReference(value.reference);
}
export function authenticateCheckpointReference(ref: CheckpointReference, child: (id: string) => CheckpointChildRecord | undefined): void {
  validateReference(ref);
  const relation = child(ref.contextId);
  if (!relation || ref.parentContextId !== relation.identity.parentContextId || ref.parentRound !== relation.round || ref.order !== relation.order || !isEqual(ref.target, relation.target)) throw new Error('Checkpoint reference differs from its relation');
}
function validateReference(value: CheckpointReference): void {
  exact(value, ['contextId', 'parentContextId', 'parentRound', 'order', 'target']);
  identity(value.contextId);
  identity(value.parentContextId);
  integer(value.parentRound, 1);
  integer(value.order, 0);
  target(value.target);
}
function target(value: { readonly position: number }): void {
  exact(value, ['position']);
  integer(value.position, 0);
}
function identity(value: string): void {
  if (typeof value !== 'string' || !value.length) throw new Error('Invalid checkpoint selection identity');
}
function integer(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid checkpoint selection number');
}
function exact(value: object, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new Error('Invalid checkpoint selection fields');
}
