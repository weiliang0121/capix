import { createHash } from 'node:crypto';
import { isEqual } from 'es-toolkit';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import type { CheckpointCommit, CheckpointValueBlock, CheckpointValueReference, CheckpointChildRecord, CheckpointChild, CheckpointHead, CheckpointImage, CheckpointSaveReceipt, CheckpointDelivery, CheckpointReferences, CheckpointPublication, CheckpointSelectionChange, CheckpointSelectionSnapshot } from './contract.js';
import { cloneCheckpointValue, cloneCheckpointImage, cloneCheckpointDelivery, CHECKPOINT_MAX_BYTES } from './value.js';
import { checkpointMetrics, checkpointEncodingOverhead, encodeCheckpointData, decodeCheckpointData, type CheckpointValueMetrics } from './encoding.js';
import { rememberCheckpointHead } from './evidence.js';
import { isCheckpointSelectionSlots, checkpointSelectionReferences, prepareCheckpointSelections, materializeCheckpointSelections, checkpointSnapshotReferences, type CheckpointStoredSelection, type CheckpointStoredOccurrence, type CheckpointSelectionReader, type CheckpointSelectionPlan } from './selections.js';

export interface CheckpointStoredValue {
  readonly id: string;
  readonly digest: string;
  readonly metrics: CheckpointValueMetrics;
  readonly uses: number;
  readonly referenceChecked: boolean;
  readonly diagnosticChecked: boolean;
}

export interface CheckpointStoredChild {
  readonly child: CheckpointChildRecord;
  readonly metrics: CheckpointValueMetrics;
}

export interface CheckpointStoredHead {
  readonly commit: Omit<CheckpointCommit, 'values' | 'children' | 'selectionChanges'>;
  readonly revision: number;
  readonly digest: string;
  readonly childCount: number;
  readonly childBytes: number;
  readonly childNodes: number;
  readonly childDepths: readonly number[];
  readonly delivery?: CheckpointDelivery;
}

/** Called wholly within the host's write transaction. Metadata reads never fetch old bodies. */
export interface CheckpointCommitReader extends CheckpointSelectionReader {
  readonly head: CheckpointStoredHead | undefined;
  value(id: string): CheckpointStoredValue | undefined;
  body(id: string): string | undefined;
  child(contextId: string): CheckpointStoredChild | undefined;
  order(order: number): string | undefined;
  imageUsed(id: string): boolean;
}

export interface CheckpointCommitPlan {
  readonly head: CheckpointStoredHead;
  readonly values: readonly { readonly stored: CheckpointStoredValue; readonly body?: string }[];
  readonly children: readonly CheckpointStoredChild[];
  readonly receipt: CheckpointSaveReceipt;
  readonly selections: readonly CheckpointSelectionPlan[];
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const blockEvidence = new WeakMap<object, { readonly body: string; readonly metrics: CheckpointValueMetrics }>();

export function createCheckpointValueBlock(id: string, value: unknown): CheckpointValueBlock {
  requireId(id);
  const fixed = cloneCheckpointValue(value);
  const body = encodeCheckpointData(fixed);
  const metrics = checkpointMetrics(fixed);
  requireMetrics(metrics);
  const block = Object.freeze({ id, digest: hash(body), value: fixed });
  blockEvidence.set(block, { body, metrics });
  return block;
}

export function cloneCheckpointCommit(value: CheckpointCommit): CheckpointCommit {
  const properties = dataProperties(value);
  if (properties.kind?.value !== 'commit' || properties.formatVersion?.value !== 6 || !Array.isArray(properties.values?.value) || !Array.isArray(properties.children?.value)) throw new Error('Invalid incremental checkpoint commit');
  const values = dataArray(properties.values.value).map((entry) => {
    const block = entry as CheckpointValueBlock;
    if (blockEvidence.has(block)) return block;
    const fields = dataProperties(block);
    if (Object.keys(fields).sort().join() !== 'digest,id,value') throw new Error('Invalid checkpoint value block fields');
    const fixed = createCheckpointValueBlock(fields.id!.value, fields.value!.value);
    if (fixed.digest !== fields.digest!.value) throw new Error('Checkpoint block digest differs from its value');
    return fixed;
  });
  const rawChildren = dataArray(properties.children.value);
  if (rawChildren.length > 4096) throw new Error('Checkpoint child limit exceeded');
  const children = Object.freeze(rawChildren.map((child) => cloneCheckpointValue(child) as unknown as CheckpointChildRecord));
  const metadata = Object.fromEntries(
    Object.entries(properties)
      .filter(([key]) => key !== 'values' && key !== 'children' && key !== 'selectionChanges')
      .map(([key, property]) => [key, property.value]),
  );
  const fixed = cloneCheckpointValue(metadata) as unknown as Omit<CheckpointCommit, 'values' | 'children' | 'selectionChanges'>;
  if (Object.keys(fixed).sort().join() !== 'contract,formatVersion,frame,id,kind,point,references,state') throw new Error('Invalid checkpoint commit fields');
  for (const reference of headReferences(fixed)) checkReference(reference);
  if (isCheckpointSelectionSlots(fixed.references)) checkpointSelectionReferences(fixed.references);
  const selectionChanges = properties.selectionChanges ? Object.freeze(dataArray(properties.selectionChanges.value).map(cloneSelectionChange)) : undefined;
  if (selectionChanges && (selectionChanges.reduce((total, change) => total + (change.append?.length ?? 0) + (change.remove?.length ?? 0) + 1, 0) > 100000 || Buffer.byteLength(encodeCheckpointData(selectionChanges)) > CHECKPOINT_MAX_BYTES)) throw new Error('Checkpoint selection delta exceeds its limits');
  const skeleton = logicalImage(fixed, [], () => null);
  cloneCheckpointImage({ ...skeleton, references: {} });
  return Object.freeze({ ...fixed, values: Object.freeze(values), children, ...(selectionChanges ? { selectionChanges } : {}) });
}

/** Digest includes the exact delta and block digests, without reserializing published value bodies. */
export function checkpointCommitDigest(commit: CheckpointCommit): string {
  const { values, ...metadata } = cloneCheckpointCommit(commit);
  return hash(encodeCheckpointData(canonicalMetadata({ ...metadata, values: values.map(({ id, digest }) => ({ id, digest })) })));
}

function canonicalMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalMetadata);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalMetadata((value as Record<string, unknown>)[key])]),
    );
  return value;
}

export function checkpointCommitReceipt(commit: CheckpointCommit, revision: number): CheckpointSaveReceipt {
  return Object.freeze({ kind: 'saved', contextId: commit.frame.owner.contextId, checkpointId: commit.id, revision, digest: checkpointCommitDigest(commit) });
}

/** Explicit cold full-image import. Ordinary running saves must submit changes instead. */
export function checkpointImageCommit(image: CheckpointImage, previous?: CheckpointCommit): CheckpointCommit {
  const fixed = cloneCheckpointImage(image);
  if (fixed.formatVersion !== 6) throw new Error('Only v6 images can import incremental facts');
  const values = new Map<string, CheckpointValueBlock>();
  const existing = new Map<string, CheckpointValueReference>();
  const priorChildren = new Map(previous?.children.map((child) => [child.identity.contextId, child]));
  if (previous) {
    for (const reference of [...headReferences(previous), ...previous.children.flatMap(childReferences)]) existing.set(reference.digest, reference);
    const ids = new Set(fixed.frame.children.map((child) => child.identity.contextId));
    if (previous.children.some((child) => !ids.has(child.identity.contextId))) throw new Error('Full checkpoint import cannot remove established child facts');
  }
  const publish = (value: unknown, expected?: CheckpointValueReference): CheckpointValueReference => {
    const digest = hash(encodeCheckpointData(value));
    if (expected?.digest === digest) return expected;
    const prior = existing.get(digest);
    if (prior) return prior;
    const id = `value:${digest}`;
    let block = values.get(id);
    if (!block) {
      block = createCheckpointValueBlock(id, value);
      values.set(id, block);
    }
    return Object.freeze({ id, digest });
  };
  const children: CheckpointChildRecord[] = fixed.frame.children.map((child) => {
    const state = child.state;
    const prior = priorChildren.get(child.identity.contextId);
    if (state.kind === 'waiting') return { ...child, input: publish(child.input, prior?.input), state };
    const priorState = prior?.state.kind === 'waiting' ? undefined : prior?.state;
    const priorReception = priorState?.reception;
    const progress = { ...state.progress, currentInput: publish(state.progress.currentInput, priorState?.progress.currentInput) };
    const reception = state.reception && ('output' in state.reception ? { ...state.reception, output: publish(state.reception.output, priorReception && 'output' in priorReception ? priorReception.output : undefined) } : state.reception.kind === 'failed' ? { ...state.reception, error: publish(state.reception.error, priorReception?.kind === 'failed' ? priorReception.error : undefined) } : state.reception);
    return { ...child, input: publish(child.input, prior?.input), state: state.kind === 'returned' ? { ...state, output: publish(state.output, priorState?.kind === 'returned' ? priorState.output : undefined), progress, reception: reception! } : { ...state, error: publish(state.error, priorState?.kind === 'failed' ? priorState.error : undefined), progress, ...(reception ? { reception } : {}) } } as CheckpointChildRecord;
  });
  const { children: _children, ...frame } = fixed.frame;
  const commit = { kind: 'commit' as const, formatVersion: 6 as const, id: fixed.id, contract: fixed.contract, point: fixed.point, frame: { ...frame, input: publish(frame.input, previous?.frame.input), currentInput: publish(frame.currentInput, previous?.frame.currentInput) }, state: publish(fixed.state, previous?.state), references: publish(fixed.references, previous && !isCheckpointSelectionSlots(previous.references) ? previous.references : undefined), values: [...values.values()], children };
  return cloneCheckpointCommit(commit);
}

/** Cold authentication after serialization. References do not confer Store membership or recovery permission. */
export function checkCheckpointPublication(image: CheckpointImage, value: unknown): CheckpointPublication {
  if (image.formatVersion !== 6) throw new Error('Legacy checkpoint heads cannot contain v6 publication references');
  const fields = dataProperties(value);
  const selectedSelections = fields.selectedSelections ? Object.freeze(dataArray(fields.selectedSelections.value).map(cloneSelectionSnapshot)) : undefined;
  const publication = cloneCheckpointCommit(
    Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => key !== 'selectedSelections')
        .map(([key, field]) => [key, field.value]),
    ) as unknown as CheckpointCommit,
  );
  if (publication.values.length !== 0 || publication.selectionChanges !== undefined) throw new Error('Checkpoint publication cannot contain pending changes or duplicate value bodies');
  let comparison = publication;
  if (isCheckpointSelectionSlots(publication.references)) {
    const references = checkpointSnapshotReferences(publication.references, image.frame.owner.contextId, selectedSelections ?? []);
    if (!isEqual(references, image.references)) throw new Error('Checkpoint selection publication differs from logical references');
    const ids = new Set([...headReferences(publication), ...publication.children.flatMap(childReferences)].map((item) => item.id));
    let id = 'publication:references';
    while (ids.has(id)) id += ':';
    comparison = { ...publication, references: { id, digest: hash(encodeCheckpointData(image.references)) } };
  } else if (selectedSelections !== undefined) throw new Error('Unexpected checkpoint selection publication');
  const reconstructed = checkpointImageCommit(image, comparison);
  if (reconstructed.values.length !== 0 || !isEqual(reconstructed, comparison)) throw new Error('Checkpoint publication differs from the complete logical image');
  const identities = new Map<string, string>();
  for (const reference of [...headReferences(publication), ...publication.children.flatMap(childReferences)]) {
    const prior = identities.get(reference.id);
    if (prior && prior !== reference.digest) throw new Error('Checkpoint publication reuses an identity with different content');
    identities.set(reference.id, reference.digest);
  }
  return Object.freeze({ ...publication, ...(selectedSelections ? { selectedSelections } : {}) });
}

export function checkCheckpointCommitReceipt(receipt: unknown, commit: CheckpointCommit, expectedRevision: number): CheckpointSaveReceipt {
  const expected = checkpointCommitReceipt(commit, nextRevision(expectedRevision));
  if (!receipt || typeof receipt !== 'object') throw new Error('Invalid checkpoint commit receipt');
  const descriptors = Object.getOwnPropertyDescriptors(receipt);
  if (Reflect.ownKeys(descriptors).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => !descriptors[key] || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable || descriptors[key]!.value !== value)) throw new Error('Checkpoint receipt differs from incremental commit');
  return expected;
}

export function prepareCheckpointCommit(request: CheckpointCommit, expectedRevision: number, reader: CheckpointCommitReader): CheckpointCommitPlan {
  const commit = cloneCheckpointCommit(request);
  const revision = nextRevision(expectedRevision);
  const previous = reader.head;
  if ((previous?.revision ?? 0) !== expectedRevision || previous?.delivery) throw new RuntimeError('CHECKPOINT_CONFLICT', 'Checkpoint head revision or terminal state differs');
  if (reader.imageUsed(commit.id)) throw new RuntimeError('CHECKPOINT_CONFLICT', 'Checkpoint identity has already been saved');
  if (previous && (!isEqual(previous.commit.frame.owner, commit.frame.owner) || !isEqual(previous.commit.contract, commit.contract) || !sameReference(previous.commit.frame.input, commit.frame.input))) throw new RuntimeError('CHECKPOINT_CONFLICT', 'Checkpoint owner, contract and original input cannot change');
  if (previous && (previous.commit.frame.round !== commit.frame.round || !isEqual(previous.commit.frame.continuation, commit.frame.continuation))) throw new RuntimeError('CHECKPOINT_CONFLICT', 'Incremental checkpoint scope cannot change round or continuation');
  const values = new Map<string, CheckpointStoredValue>();
  const bodies = new Map<string, string>();
  const supplied = new Set<string>();
  for (const block of commit.values) {
    if (supplied.has(block.id)) throw new Error('Duplicate checkpoint value block');
    supplied.add(block.id);
    const proof = blockEvidence.get(block)!;
    const old = reader.value(block.id);
    if (old && (old.digest !== block.digest || (old.uses > 0 && reader.body(block.id) !== proof.body))) throw new Error('Checkpoint value identity has different content');
    values.set(block.id, { id: block.id, digest: block.digest, metrics: proof.metrics, uses: old?.uses ?? 0, referenceChecked: old?.referenceChecked ?? false, diagnosticChecked: old?.diagnosticChecked ?? false });
    bodies.set(block.id, proof.body);
  }
  const valueInfo = (reference: CheckpointValueReference): CheckpointStoredValue => {
    checkReference(reference);
    let info = values.get(reference.id);
    if (!info) {
      info = reader.value(reference.id);
      if (!info || info.uses === 0) throw new Error('Checkpoint references a missing or retired value body');
      values.set(reference.id, info);
    }
    if (info.digest !== reference.digest) throw new Error('Checkpoint value reference digest differs');
    if (!Number.isSafeInteger(info.uses) || info.uses < 0 || typeof info.referenceChecked !== 'boolean' || typeof info.diagnosticChecked !== 'boolean') throw new Error('Invalid checkpoint value metadata');
    requireMetrics(info.metrics);
    return info;
  };
  const deltas = new Map<string, number>();
  const account = (reference: CheckpointValueReference, direction: number) => {
    valueInfo(reference);
    deltas.set(reference.id, (deltas.get(reference.id) ?? 0) + direction);
  };
  if (previous) for (const reference of headReferences(previous.commit)) account(reference, -1);
  for (const reference of headReferences(commit)) account(reference, 1);
  let childCount = previous?.childCount ?? 0;
  let childBytes = previous?.childBytes ?? 0;
  let childNodes = previous?.childNodes ?? 0;
  const childDepths = [...(previous?.childDepths ?? Array.from({ length: 65 }, () => 0))];
  const children: CheckpointStoredChild[] = [];
  const changed = new Map<string, CheckpointChildRecord>();
  const orders = new Map<number, string>();
  for (const child of commit.children) {
    if (changed.has(child.identity.contextId)) throw new Error('Duplicate changed checkpoint relation');
    const old = reader.child(child.identity.contextId);
    validateChildMetadata(commit, child);
    if (old) {
      checkChildAdvance(old.child, child);
      childBytes -= old.metrics.bytes;
      childNodes -= old.metrics.nodes;
      childDepths[old.metrics.depth] = childDepths[old.metrics.depth]! - 1;
      for (const reference of childReferences(old.child)) account(reference, -1);
    } else {
      if (previous && child.order < previous.commit.frame.nextChildOrder) throw new Error('New checkpoint relation precedes the established order');
      childCount++;
    }
    const existing = orders.get(child.order) ?? reader.order(child.order);
    if (existing !== undefined && existing !== child.identity.contextId) throw new Error('Duplicate checkpoint child order');
    orders.set(child.order, child.identity.contextId);
    changed.set(child.identity.contextId, child);
    for (const reference of childReferences(child)) account(reference, 1);
    for (const reference of diagnosticReferences(child)) {
      const info = valueInfo(reference);
      if (!info.diagnosticChecked) {
        const body = bodies.get(info.id) ?? reader.body(info.id);
        if (body === undefined) throw new Error('Checkpoint diagnostic body is missing');
        const diagnostic = decodeCheckpointData(body);
        if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic) || !('code' in diagnostic) || typeof diagnostic.code !== 'string' || !diagnostic.code.length || !('message' in diagnostic) || typeof diagnostic.message !== 'string') throw new Error('Invalid checkpoint diagnostic');
        values.set(info.id, { ...info, diagnosticChecked: true });
      }
    }
    const metrics = referencedMetrics(child, childReferences(child), valueInfo);
    requireMetrics(metrics);
    childBytes += metrics.bytes;
    childNodes += metrics.nodes;
    childDepths[metrics.depth] = childDepths[metrics.depth]! + 1;
    children.push({ child, metrics });
  }
  if (childCount > 4096 || childCount < 0 || childDepths.length !== 65 || childDepths.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('Checkpoint child aggregate exceeds its limits');
  if (previous && commit.frame.nextChildOrder < previous.commit.frame.nextChildOrder) throw new Error('Checkpoint next child order cannot regress');
  const selections = prepareCheckpointSelections(commit, reader, (id) => changed.get(id) ?? reader.child(id)?.child);
  if (!isCheckpointSelectionSlots(commit.references)) {
    const refsInfo = valueInfo(commit.references);
    if (!refsInfo.referenceChecked) {
      const body = bodies.get(refsInfo.id) ?? reader.body(refsInfo.id);
      if (body === undefined) throw new Error('Checkpoint reference value body is missing');
      const references = decodeCheckpointData(body) as CheckpointReferences;
      authenticateReferences(references, (id) => changed.get(id) ?? reader.child(id)?.child);
      values.set(refsInfo.id, { ...refsInfo, referenceChecked: true });
    }
  }
  const depth = childDepths.findLastIndex((count) => count > 0);
  const aggregate: CheckpointValueMetrics = { bytes: 2 + childBytes + Math.max(0, childCount - 1), nodes: 1 + childNodes, depth: depth < 0 ? 0 : depth + 1 };
  const linkedChildren: readonly CheckpointChild[] = [];
  const linkedReferences = {};
  const skeleton = logicalImage(commit, linkedChildren, (reference) => reference, selections ? linkedReferences : undefined);
  const markers = new Map<object, CheckpointValueMetrics>(headReferences(commit).map((ref) => [ref, valueInfo(ref).metrics]));
  markers.set(linkedChildren, aggregate);
  if (selections) markers.set(linkedReferences, selections.metrics);
  requireMetrics(checkpointMetrics(skeleton, (item) => markers.get(item)));
  const updates: { stored: CheckpointStoredValue; body?: string }[] = [];
  for (const [id, info] of values) {
    const uses = info.uses + (deltas.get(id) ?? 0);
    if (!Number.isSafeInteger(uses) || uses < 0) throw new Error('Invalid checkpoint value reference count');
    if (supplied.has(id) && uses === 0) throw new Error('Unused new checkpoint value');
    const body = bodies.get(id);
    const prior = reader.value(id);
    if ((deltas.get(id) ?? 0) !== 0 || body !== undefined || info.referenceChecked !== prior?.referenceChecked || info.diagnosticChecked !== prior?.diagnosticChecked) updates.push({ stored: { ...info, uses }, ...(body !== undefined ? { body } : {}) });
  }
  const { values: _values, children: _children, selectionChanges: _selectionChanges, ...header } = commit;
  const receipt = checkpointCommitReceipt(commit, revision);
  const head = Object.freeze({ commit: header, revision, digest: receipt.digest, childCount, childBytes, childNodes, childDepths: Object.freeze(childDepths) });
  return { head, values: updates, children, receipt, selections: selections?.plans ?? [] };
}

export function materializeCheckpointHead(head: CheckpointStoredHead, children: readonly CheckpointStoredChild[], values: readonly { readonly stored: CheckpointStoredValue; readonly body: string }[], selections: readonly { readonly head: CheckpointStoredSelection; readonly occurrences: readonly CheckpointStoredOccurrence[] }[] = []): CheckpointHead {
  cloneCheckpointCommit({ ...head.commit, values: [], children: [] });
  if (typeof head.digest !== 'string' || !/^[a-f0-9]{64}$/.test(head.digest)) throw new Error('Invalid persisted checkpoint receipt digest');
  const loaded = new Map<string, { stored: CheckpointStoredValue; value: unknown }>();
  const counts = new Map<string, number>();
  for (const { stored, body } of values) {
    if (loaded.has(stored.id) || stored.uses < 1 || hash(body) !== stored.digest) throw new Error('Invalid persisted checkpoint value');
    const value = cloneCheckpointValue(decodeCheckpointData(body));
    if (!isEqual(checkpointMetrics(value), stored.metrics)) throw new Error('Persisted checkpoint value metrics differ');
    loaded.set(stored.id, { stored, value });
  }
  const resolve = (reference: CheckpointValueReference): any => {
    checkReference(reference);
    const value = loaded.get(reference.id);
    if (!value || value.stored.digest !== reference.digest) throw new Error('Missing persisted checkpoint value');
    counts.set(reference.id, (counts.get(reference.id) ?? 0) + 1);
    return value.value;
  };
  const ordered = [...children].sort((a, b) => a.child.order - b.child.order);
  let childBytes = 0;
  let childNodes = 0;
  const childDepths = Array.from({ length: 65 }, () => 0);
  for (const entry of ordered) {
    const metrics = referencedMetrics(entry.child, childReferences(entry.child), (ref) => {
      const found = loaded.get(ref.id)?.stored;
      if (!found || found.digest !== ref.digest) throw new Error('Missing child checkpoint value');
      return found;
    });
    if (!isEqual(metrics, entry.metrics)) throw new Error('Persisted relation metrics differ');
    requireMetrics(metrics);
    childBytes += metrics.bytes;
    childNodes += metrics.nodes;
    childDepths[metrics.depth] = childDepths[metrics.depth]! + 1;
  }
  if (head.childCount !== ordered.length || childBytes !== head.childBytes || childNodes !== head.childNodes || !isEqual(childDepths, head.childDepths)) throw new Error('Persisted checkpoint aggregates differ');
  const selected = isCheckpointSelectionSlots(head.commit.references) ? materializeCheckpointSelections(head.commit.references, head.commit.frame.owner.contextId, selections) : undefined;
  if (!selected && selections.length) throw new Error('Unexpected checkpoint selections');
  const image = cloneCheckpointImage(
    logicalImage(
      head.commit,
      ordered.map(({ child }) => mapChild(child, resolve)),
      resolve,
      selected?.references,
    ),
  );
  for (const [id, item] of loaded) if (counts.get(id) !== item.stored.uses) throw new Error('Persisted value references differ');
  if (image.formatVersion !== 6 || !Number.isSafeInteger(head.revision) || head.revision < 1) throw new Error('Invalid incremental checkpoint head');
  requireMetrics(checkpointMetrics(image));
  const publication = Object.freeze({ ...head.commit, values: Object.freeze([]), children: Object.freeze(ordered.map(({ child }) => child)), ...(selected ? { selectedSelections: selected.snapshots } : {}) });
  const output = Object.freeze({ revision: head.revision, image, ...(head.delivery ? { delivery: cloneCheckpointDelivery(head.delivery) } : {}), publication });
  rememberCheckpointHead(output, publication);
  return output;
}

function logicalImage(commit: Omit<CheckpointCommit, 'values' | 'children'>, children: readonly CheckpointChild[], resolve: (reference: CheckpointValueReference) => any, references?: CheckpointReferences): CheckpointImage {
  return { id: commit.id, formatVersion: 6, contract: commit.contract, point: commit.point, frame: { ...commit.frame, input: resolve(commit.frame.input), currentInput: resolve(commit.frame.currentInput), children }, state: resolve(commit.state), references: references ?? (isCheckpointSelectionSlots(commit.references) ? {} : resolve(commit.references)) };
}

function validateChildMetadata(commit: CheckpointCommit, child: CheckpointChildRecord): void {
  for (const reference of childReferences(child)) checkReference(reference);
  const placeholders = new Set(diagnosticReferences(child));
  const skeleton = logicalImage(commit, [mapChild(child, (reference) => (placeholders.has(reference) ? { code: 'CHECKPOINT_DIAGNOSTIC', message: '' } : null))], () => null);
  cloneCheckpointImage({ ...skeleton, references: {} });
}

function checkChildAdvance(previous: CheckpointChildRecord, child: CheckpointChildRecord): void {
  const { state: a, ...basisA } = previous;
  const { state: b, ...basisB } = child;
  if (!isEqual(basisA, basisB)) throw new Error('Checkpoint child identity and input cannot change');
  if (a.kind === 'waiting') return;
  if (a.kind !== b.kind) throw new Error('Checkpoint child outcome cannot change');
  if (a.kind === 'returned' && b.kind === 'returned') {
    if (!sameReference(a.output, b.output) || !isEqual(a.progress, b.progress)) throw new Error('Checkpoint returned fact cannot change');
    if (a.reception.kind === 'accepted' || a.reception.kind === 'failed') {
      if (!isEqual(a.reception, b.reception)) throw new Error('Checkpoint completed reception cannot change');
    } else if (a.reception.kind === 'receiving' && (b.reception.kind === 'pending' || !isEqual(a.reception.contract, b.reception.contract))) throw new Error('Checkpoint reception cannot regress or replace its contract');
  } else if (a.kind === 'failed' && b.kind === 'failed' && !isEqual(a, b)) throw new Error('Checkpoint handled failure cannot change');
}

function mapChild(child: CheckpointChildRecord, resolve: (reference: CheckpointValueReference) => any): CheckpointChild {
  const state = child.state;
  if (state.kind === 'waiting') return { ...child, input: resolve(child.input), state };
  const progress = { ...state.progress, currentInput: resolve(state.progress.currentInput) };
  const reception = state.reception && ('output' in state.reception ? { ...state.reception, output: resolve(state.reception.output!) } : state.reception.kind === 'failed' ? { ...state.reception, error: resolve(state.reception.error) } : state.reception);
  return { ...child, input: resolve(child.input), state: state.kind === 'returned' ? { ...state, output: resolve(state.output), progress, reception: reception! } : { ...state, error: resolve(state.error), progress, ...(reception ? { reception } : {}) } } as CheckpointChild;
}

function headReferences(commit: Pick<CheckpointCommit, 'frame' | 'state' | 'references'>): CheckpointValueReference[] {
  return [commit.frame.input, commit.frame.currentInput, commit.state, ...(isCheckpointSelectionSlots(commit.references) ? [] : [commit.references])];
}

function childReferences(child: CheckpointChildRecord): CheckpointValueReference[] {
  const refs = [child.input];
  if (child.state.kind !== 'waiting') {
    refs.push(child.state.progress.currentInput, child.state.kind === 'returned' ? child.state.output : child.state.error);
    const reception = child.state.reception;
    if (reception && 'output' in reception) refs.push(reception.output!);
    if (reception?.kind === 'failed') refs.push(reception.error);
  }
  return refs;
}

function diagnosticReferences(child: CheckpointChildRecord): CheckpointValueReference[] {
  const state = child.state;
  if (state.kind === 'failed') return [state.error];
  return state.kind === 'returned' && state.reception.kind === 'failed' ? [state.reception.error] : [];
}

function referencedMetrics(value: unknown, refs: readonly CheckpointValueReference[], lookup: (ref: CheckpointValueReference) => CheckpointStoredValue): CheckpointValueMetrics {
  const markers = new Map<object, CheckpointValueMetrics>(refs.map((reference) => [reference, lookup(reference).metrics]));
  return checkpointMetrics(value, (item) => markers.get(item));
}

function authenticateReferences(references: CheckpointReferences, child: (id: string) => CheckpointChildRecord | undefined): void {
  if (!references || typeof references !== 'object' || Array.isArray(references)) throw new Error('Invalid checkpoint references');
  for (const selected of Object.values(references))
    for (const ref of Array.isArray(selected) ? selected : [selected]) {
      const relation = child(ref.contextId);
      if (!relation || Object.keys(ref).sort().join() !== 'contextId,order,parentContextId,parentRound,target' || ref.parentContextId !== relation.identity.parentContextId || ref.parentRound !== relation.round || ref.order !== relation.order || !isEqual(ref.target, relation.target)) throw new Error('Checkpoint reference differs from its relation');
    }
}

function sameReference(a: CheckpointValueReference, b: CheckpointValueReference): boolean {
  return a.id === b.id && a.digest === b.digest;
}
function cloneSelectionChange(value: unknown): CheckpointSelectionChange {
  const fields = dataProperties(value);
  const header = cloneCheckpointValue(
    Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => key !== 'append' && key !== 'remove')
        .map(([key, field]) => [key, field.value]),
    ),
  ) as unknown as CheckpointSelectionChange;
  const append = fields.append ? Object.freeze(dataArray(fields.append.value).map((item) => cloneCheckpointValue(item) as unknown as NonNullable<CheckpointSelectionChange['append']>[number])) : undefined;
  const remove = fields.remove ? Object.freeze(dataArray(fields.remove.value).map((item) => cloneCheckpointValue(item) as unknown as NonNullable<CheckpointSelectionChange['remove']>[number])) : undefined;
  return Object.freeze({ ...header, ...(append ? { append } : {}), ...(remove ? { remove } : {}) });
}
function cloneSelectionSnapshot(value: unknown): CheckpointSelectionSnapshot {
  const fields = dataProperties(value);
  const header = cloneCheckpointValue(
    Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => key !== 'occurrences')
        .map(([key, field]) => [key, field.value]),
    ),
  ) as unknown as Omit<CheckpointSelectionSnapshot, 'occurrences'>;
  const occurrences = Object.freeze(dataArray(fields.occurrences?.value).map((item) => cloneCheckpointValue(item) as unknown as CheckpointSelectionSnapshot['occurrences'][number]));
  return Object.freeze({ ...header, occurrences });
}
function dataProperties(value: unknown): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Checkpoint metadata requires an ordinary data record');
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(properties)) {
    const property = typeof key === 'string' ? properties[key] : undefined;
    if (!property || !('value' in property) || !property.enumerable) throw new Error('Checkpoint metadata cannot contain accessors or hidden properties');
  }
  return properties;
}
function dataArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Checkpoint metadata requires an array');
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(descriptors).length !== length + 1) throw new Error('Checkpoint metadata requires a dense data array');
  return Array.from({ length }, (_, index) => {
    const property = descriptors[String(index)];
    if (!property || !('value' in property) || !property.enumerable) throw new Error('Checkpoint metadata array cannot contain accessors');
    return property.value;
  });
}
function checkReference(value: CheckpointValueReference): void {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'digest,id') throw new Error('Invalid checkpoint value reference');
  requireId(value.id);
  if (!/^[a-f0-9]{64}$/.test(value.digest)) throw new Error('Invalid checkpoint value digest');
}
function requireId(value: string): void {
  if (typeof value !== 'string' || !value.length) throw new Error('Checkpoint value identity is required');
}
function requireMetrics(value: CheckpointValueMetrics): void {
  if (!Number.isSafeInteger(value.bytes) || !Number.isSafeInteger(value.nodes) || !Number.isSafeInteger(value.depth) || value.bytes < 1 || value.nodes < 1 || value.depth < 0 || value.bytes + checkpointEncodingOverhead > CHECKPOINT_MAX_BYTES || value.nodes > 100_000 || value.depth > 64) throw new Error('Checkpoint logical image exceeds its limits');
}
function nextRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid checkpoint expected revision');
  return value + 1;
}
