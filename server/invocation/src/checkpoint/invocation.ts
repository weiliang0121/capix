import { stableValue, type Stable } from '@capix/contracts';
import { randomUUID } from 'node:crypto';
import { isEqual } from 'es-toolkit';
import type { Invocation } from '../invocation/invocation.js';
import type { InvocationContext } from '../context/context.js';
import { ProgressChannel } from '@capix/changes';
import type { InvocationObservation } from '../observation/invocation.js';
import { ObserverSession } from '../observation/session.js';
import type { CheckpointFact, CheckpointInstallation, CheckpointRestoration, CheckpointWriter } from './contract.js';
import type { CheckpointHead, CheckpointChild, CheckpointReferences, CheckpointValueBlock, CheckpointCommit, InvocationCheckpointFrame } from '@capix/checkpoint';
import { cloneCheckpointHead, cloneCheckpointDelivery, cloneCheckpointValue, checkCheckpointFinishReceipt, checkpointHeadCommit, createCheckpointValueBlock, checkCheckpointCommitReceipt } from '@capix/checkpoint';
import type { InvocationCheckpointWork } from './work.js';
import type { InvocationTarget } from '../invocation/relation.js';
import { publishCheckpointChild, publishCheckpointValue, encodeCheckpointFact, restoredCheckpointChild, type PublishedCheckpointValue, type PublishedCheckpointChild } from './publication.js';
import { checkpointDataEqual, runCheckpointCheck } from './data.js';
import type { DecodedCheckpointFrame } from './facts.js';
import { decodeCheckpointChild, resolveCheckpointChild } from './children.js';
import { checkpointChildBinding, checkCheckpointReferences, decodeCheckpointFrame } from './facts.js';
import { restoreCheckpointContinuation } from './continuation.js';
import { CheckpointObservation } from './observation.js';

type Event = CheckpointFact extends infer F ? (F extends CheckpointFact ? Omit<F, 'activityId' | 'contextId' | 'owner' | 'recovering' | 'sequence' | 'occurredAt'> : never) : never;
const active = new WeakMap<object, Set<string>>();

/** One activity coordinates declared capture, durable storage and separate passive facts. */
export class InvocationCheckpoint<Input, Output, Context extends InvocationContext<Input, Output>> {
  readonly activityId = randomUUID();
  readonly observation: InvocationObservation;
  #sequence = 0;
  #revision = 0;
  #checkpointId?: string;
  #saving = false;
  #commitUncertain = false;
  #claimed = false;
  #ready = false;
  #terminal = false;
  #restore?: CheckpointHead;
  #input?: PublishedCheckpointValue;
  #currentInput?: PublishedCheckpointValue;
  readonly #published = new Map<string, PublishedCheckpointChild>();
  readonly #savedChildren = new Map<string, CheckpointChild>();
  readonly #resumedChildren = new Map<string, InvocationTarget>();
  readonly #observer?: ObserverSession<{ observe(fact: CheckpointFact): void; available?(): boolean }>;
  readonly #feedback?: ProgressChannel<CheckpointFact>;
  constructor(
    private readonly invocation: Invocation<Input, Output, Context>,
    private readonly installation: CheckpointInstallation,
    private readonly work: InvocationCheckpointWork<Input, Output, Context> | undefined,
    private readonly signal: AbortSignal,
    restore?: CheckpointRestoration,
  ) {
    this.#observer = installation.observation ? new ObserverSession({ observe: (fact: CheckpointFact) => installation.observation!.observe(fact), available: () => true }, installation.observation.failure ?? 'isolate') : undefined;
    this.#feedback = installation.feedback ? new ProgressChannel(installation.feedback) : undefined;
    this.observation = new CheckpointObservation((event) => this.emit(event));
    if (restore) {
      this.#restore = cloneCheckpointHead(restore.head);
      this.#revision = this.#restore.revision;
      this.#checkpointId = this.#restore.image.id;
      const image = this.#restore.image;
      if (!work || image.formatVersion !== 6 || this.#restore.delivery || image.contract.key !== work.key || image.contract.version !== work.version || !isEqual(image.frame.owner, invocation.identity) || image.frame.round !== 1 || image.frame.continuation !== undefined || !work.points[image.point]) throw new Error('Incompatible checkpoint continuation');
      if (invocation.context.progress.round !== image.frame.round || !checkpointDataEqual(cloneCheckpointValue(work.input.encode(invocation.context.currentInput)), image.frame.currentInput) || !checkpointDataEqual(cloneCheckpointValue(work.input.encode(invocation.context.input)), image.frame.input)) throw new Error('Checkpoint input changed during binding');
      if (!isEqual(invocation.context.continuation, restoreCheckpointContinuation(image.frame))) throw new Error('Checkpoint continuation changed during binding');
      checkCheckpointReferences(image.frame, image.references, work.points[image.point]!.references);
      const children = image.frame.children.map((child) => decodeCheckpointChild(child, checkpointChildBinding(child, work.children), signal, work.receptions));
      invocation.children.install(image.frame.nextChildOrder, children);
      let basis = checkpointHeadCommit(this.#restore);
      if (!basis) {
        const current = installation.store.read(invocation.context.id);
        if (!current || current.revision !== this.#restore.revision || !checkpointDataEqual(current.image, image) || current.delivery) throw new Error('Checkpoint publication differs from the supplied head');
        basis = checkpointHeadCommit(current);
      }
      if (!basis) throw new Error('Checkpoint has no authenticated publication basis');
      this.#input = Object.freeze({ source: invocation.context.input, encoded: image.frame.input, reference: basis.frame.input });
      this.#currentInput = Object.freeze({ source: invocation.context.currentInput, encoded: image.frame.currentInput, reference: basis.frame.currentInput });
      const decoded = decodeCheckpointFrame(image.frame, work, work.children, work.receptions);
      const records = new Map(basis.children.map((child) => [child.identity.contextId, child]));
      for (let index = 0; index < image.frame.children.length; index++) {
        const child = image.frame.children[index]!;
        const relation = invocation.children.byContextId(child.identity.contextId)!;
        const record = records.get(child.identity.contextId);
        if (!record) throw new Error('Checkpoint child publication basis is missing');
        this.#savedChildren.set(child.identity.contextId, child);
        this.#published.set(child.identity.contextId, restoredCheckpointChild(child, decoded.children[index]!, record, relation));
      }
    }
    if (work) {
      invocation.children.trackFacts();
      if (restore) invocation.children.acknowledgeFacts(invocation.children.factRevision);
    }
  }
  private emit(event: Event): void {
    const fact = Object.freeze({ ...event, activityId: this.activityId, contextId: this.invocation.context.id, owner: this.invocation.identity, recovering: this.invocation.recovering, sequence: ++this.#sequence, occurredAt: new Date().toISOString() }) as CheckpointFact;
    this.#feedback?.publish(fact);
    const error = this.#observer?.publish((observer) => observer.observe(fact));
    if (error !== undefined) throw error;
  }
  begin(): void {
    try {
      this.install();
    } catch (error) {
      this.reportFailure('restore', error);
      throw error;
    }
  }
  reportFailure(stage: 'restore' | 'finish', error: unknown, childContextId?: string): void {
    try {
      this.emit({ kind: 'failed', stage, error, ...(childContextId ? { childContextId } : {}) });
    } catch {
      /* The primary failure remains authoritative. */
    }
  }
  private install(): void {
    let owners = active.get(this.installation.store);
    if (!owners) {
      owners = new Set();
      active.set(this.installation.store, owners);
    }
    if (owners.has(this.invocation.context.id)) throw new Error('Checkpoint work is already active in this host');
    owners.add(this.invocation.context.id);
    this.#claimed = true;
    if (!this.#restore) {
      this.#ready = true;
      return;
    }
    const image = this.#restore.image;
    this.emit({ kind: 'checking', checkpointId: image.id, point: image.point });
    const current = this.installation.store.read(this.invocation.context.id);
    if (!current || current.delivery || current.revision !== this.#restore.revision || !checkpointDataEqual(current.image, image)) throw new Error('Checkpoint head changed before continuation');
    const point = this.work!.points[image.point]!;
    const decoded = decodeCheckpointFrame(image.frame, this.work!, this.work!.children, this.work!.receptions);
    checkCheckpointReferences(image.frame, image.references, point.references);
    this.invocation.children.readFacts(() => runCheckpointCheck(() => point.check?.(image.frame, stableValue(point.state.decode(image.state)), image.references, decoded)));
    this.emit({ kind: 'installed', checkpointId: image.id, point: image.point, frame: image.frame });
    this.#ready = true;
  }
  release(): void {
    if (this.#claimed) active.get(this.installation.store)?.delete(this.invocation.context.id);
    this.#claimed = false;
  }
  writer(): CheckpointWriter | undefined {
    if (!this.work) return undefined;
    const round = this.invocation.context.progress.round;
    return Object.freeze({
      save: (point: string, state: unknown, references: CheckpointReferences = {}) => {
        let stage: 'capture' | 'save' = 'capture';
        let entered = false;
        try {
          if (this.#saving) throw new Error('Checkpoint save cannot reenter the same invocation');
          this.#saving = true;
          entered = true;
          const revision = this.#revision;
          this.invocation.requireActive();
          const context = this.invocation.context;
          if (!this.#claimed || this.#terminal || this.#commitUncertain || context.progress.phase !== 'execute' || context.progress.round !== round) throw new Error('Checkpoint writer is outside its executing round');
          const definition = this.work!.points[point];
          if (!definition) throw new Error('Checkpoint point is not declared');
          return this.invocation.children.readFacts(() => {
            let activeCut = true;
            try {
              const factRevision = this.invocation.children.factRevision;
              const blocks: CheckpointValueBlock[] = [];
              this.#input ??= publishCheckpointValue(context.input, this.work!.input, blocks);
              const input = this.#input;
              this.#currentInput ??= Object.is(input.source, context.currentInput) ? input : publishCheckpointValue(context.currentInput, this.work!.input, blocks);
              const currentInput = this.#currentInput;
              if (!Object.is(input.source, context.input) || !Object.is(currentInput.source, context.currentInput)) throw new Error('Checkpoint fixed input changed');
              const changes = new Map<string, PublishedCheckpointChild>();
              for (const relation of this.invocation.children.changedFacts()) {
                const id = relation.invocation.context.id;
                const publication = publishCheckpointChild(context, relation, this.#savedChildren.get(id), this.#published.get(id), blocks);
                checkpointChildBinding(publication.encoded, this.work!.children);
                changes.set(id, publication);
              }
              const lookup = (id: string) => {
                if (!activeCut) throw new Error('Checkpoint frame query is outside its save');
                return changes.get(id) ?? this.#published.get(id);
              };
              const all = () => {
                if (!activeCut) throw new Error('Checkpoint frame query is outside its save');
                const children = Array.from(this.#published, ([id, child]) => changes.get(id) ?? child);
                for (const [id, child] of changes) if (!this.#published.has(id)) children.push(child);
                return children;
              };
              const savedState = cloneCheckpointValue(definition.state.encode(state));
              const decodedState = stableValue(definition.state.decode(savedState));
              const stateBlock = createCheckpointValueBlock(randomUUID(), savedState);
              const referencesBlock = createCheckpointValueBlock(randomUUID(), references);
              blocks.push(stateBlock, referencesBlock);
              const fixedReferences = referencesBlock.value as unknown as CheckpointReferences;
              const frame: InvocationCheckpointFrame = Object.freeze({
                owner: this.invocation.identity,
                phase: 'execute',
                round,
                input: input.encoded,
                currentInput: currentInput.encoded,
                nextChildOrder: this.invocation.children.nextOrder,
                get children() {
                  return Object.freeze(all().map((child) => child.encoded));
                },
              });
              const decoded: DecodedCheckpointFrame = Object.freeze({
                owner: this.invocation.identity,
                phase: 'execute',
                round,
                input: context.input,
                currentInput: context.currentInput,
                nextChildOrder: frame.nextChildOrder,
                child: (id: string) => lookup(id)?.decoded,
                get children() {
                  return Object.freeze(all().map((child) => child.decoded));
                },
              });
              checkCheckpointReferences(frame, fixedReferences, definition.references, (id) => lookup(id)?.encoded);
              runCheckpointCheck(() => definition.check?.(frame, decodedState, fixedReferences, decoded));
              const commit: CheckpointCommit = Object.freeze({ kind: 'commit', formatVersion: 6, id: randomUUID(), contract: Object.freeze({ key: this.work!.key, version: this.work!.version }), point, frame: Object.freeze({ owner: this.invocation.identity, phase: 'execute' as const, round, input: input.reference, currentInput: currentInput.reference, nextChildOrder: frame.nextChildOrder }), state: Object.freeze({ id: stateBlock.id, digest: stateBlock.digest }), references: Object.freeze({ id: referencesBlock.id, digest: referencesBlock.digest }), values: Object.freeze(blocks), children: Object.freeze(Array.from(changes.values(), (child) => child.record)) });
              this.emit({ kind: 'captured', checkpointId: commit.id, point });
              stage = 'save';
              this.invocation.requireActive();
              if (!this.#claimed || this.#terminal || context.progress.phase !== 'execute' || context.progress.round !== round || this.#revision !== revision || this.invocation.children.factRevision !== factRevision) throw new Error('Checkpoint save baseline changed before commit');
              this.#commitUncertain = true;
              const receipt = checkCheckpointCommitReceipt(this.installation.store.save(commit, revision), commit, revision);
              this.#revision = receipt.revision;
              this.#checkpointId = receipt.checkpointId;
              for (const [id, child] of changes) this.#published.set(id, child);
              this.invocation.children.acknowledgeFacts(factRevision);
              this.#commitUncertain = false;
              this.emit({ kind: 'saved', checkpointId: commit.id, point });
              return receipt;
            } finally {
              activeCut = false;
            }
          });
        } catch (error) {
          this.invocation.reject(error);
          try {
            this.emit({ kind: 'failed', stage, error });
          } catch {
            /* Preserve the primary storage/capture failure. */
          }
          throw error;
        } finally {
          if (entered) this.#saving = false;
        }
      },
    });
  }
  resume(): Output | Stable<Output> | Promise<Output | Stable<Output>> {
    if (!this.#restore || !this.work) throw new Error('Invocation has no continuation');
    const image = this.#restore.image;
    const point = this.work.points[image.point]!;
    this.emit({ kind: 'continued', checkpointId: image.id, point: image.point });
    return point.execute(this.invocation.context, this.invocation, point.state.decode(image.state), image.references);
  }
  restoreChild(position: number, contextId: string, create: () => InvocationTarget): InvocationTarget {
    if (!this.#restore) throw new Error('Child continuation requires a restored parent');
    const saved = this.#savedChildren.get(contextId);
    const resumed = this.#resumedChildren.get(contextId);
    if (resumed) {
      if (this.invocation.children.get(resumed).declarationPosition !== position) throw new Error('Child continuation declaration position or ownership mismatch');
      return resumed;
    }
    if (!saved) throw new Error('Child continuation basis is unavailable');
    if (saved.target.position !== position) throw new Error('Child continuation declaration position or ownership mismatch');
    const binding = checkpointChildBinding(saved, this.work?.children);
    const restored = resolveCheckpointChild(saved, saved.state.kind === 'waiting' ? this.installation.store.read(contextId) : undefined);
    if (restored.kind === 'continuation') {
      // Construction adopts the placeholder through the child's Invocation constructor.
      const target = create();
      const relation = this.invocation.children.get(target);
      if (target.context.id !== contextId || relation.round !== saved.round || relation.order !== saved.order || relation.declarationPosition !== saved.target.position) throw new Error('Child continuation did not adopt the saved relationship');
      const published = this.#published.get(contextId);
      if (published) this.#published.set(contextId, restoredCheckpointChild(published.encoded, published.decoded, published.record, relation));
      this.#savedChildren.delete(contextId);
      this.#resumedChildren.set(contextId, target);
      this.emit({ kind: 'child-restored', child: saved, mode: 'continuation' });
      return target;
    }
    const child = restored.child;
    const decoded = decodeCheckpointChild(child, binding, this.signal, this.work?.receptions);
    this.invocation.children.replaceSaved(contextId, decoded.target, decoded.state);
    const published = this.#published.get(contextId);
    if (published) this.#published.set(contextId, restoredCheckpointChild(published.encoded, published.decoded, published.record, this.invocation.children.get(decoded.target)));
    this.#savedChildren.set(contextId, child);
    this.#resumedChildren.set(contextId, decoded.target);
    this.emit({ kind: 'child-restored', child, mode: 'delivery' });
    return decoded.target;
  }
  finish(result: { status: 'succeeded'; output: Stable<Output> } | { status: 'failed' | 'cancelled' }): void {
    try {
      this.finalize(result);
    } catch (error) {
      this.reportFailure('finish', error);
      throw error;
    }
  }
  private finalize(result: { status: 'succeeded'; output: Stable<Output> } | { status: 'failed' | 'cancelled' }): void {
    // A throwing Store or invalid acknowledgement can follow a real commit.
    // Do not issue a second write from the failure-finalization path.
    if (!this.#checkpointId || this.#terminal || this.#commitUncertain || !this.#claimed || !this.#ready) return;
    const revision = this.#revision;
    const checkpointId = this.#checkpointId;
    const delivery = cloneCheckpointDelivery(result.status === 'succeeded' ? { status: 'succeeded', output: encodeCheckpointFact(result.output, this.work!.output).encoded, progress: { round: this.invocation.context.progress.round, phase: this.invocation.context.progress.phase, currentInput: this.#currentInput!.encoded } } : result);
    // Final-delivery checking precedes durable finalization; errors can still be owned here.
    this.emit({ kind: 'finishing', status: delivery.status });
    this.#commitUncertain = true;
    const receipt = checkCheckpointFinishReceipt(this.installation.store.finish(this.invocation.context.id, revision, delivery), this.invocation.context.id, checkpointId, delivery, revision);
    this.#revision = receipt.revision;
    this.#commitUncertain = false;
    this.#terminal = true;
    // The committed delivery is fixed. A passive post-commit notification cannot rewrite it.
    try {
      this.emit({ kind: 'finished', status: delivery.status });
    } catch {
      /* Consumer is disabled by its session. */
    }
  }
}
