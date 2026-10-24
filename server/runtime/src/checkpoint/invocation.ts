import { randomUUID } from 'node:crypto';
import { isEqual } from 'es-toolkit';
import type { Invocation } from '../invocation/invocation.js';
import type { InvocationContext } from '../context/context.js';
import { InvocationObservation } from '../observation/invocation.js';
import type { InvocationObserver } from '../observation/observer.js';
import { ObserverSession } from '../observation/session.js';
import type { CheckpointFact, CheckpointHead, CheckpointInstallation, CheckpointRestoration, CheckpointWriter, CheckpointDelivery, CheckpointChild, CheckpointReferences } from './contract.js';
import { cloneCheckpointHead, cloneCheckpointImage, cloneCheckpointValue } from './value.js';
import type { InvocationCheckpointWork } from './work.js';
import type { InvocationTarget } from '../invocation/relation.js';
import { captureCheckpointChildren, decodeCheckpointChild, resolveCheckpointChild } from './children.js';
import { checkpointChildBinding, checkCheckpointReferences, decodeCheckpointFrame } from './facts.js';
import { captureCheckpointContinuation, restoreCheckpointContinuation } from './continuation.js';

type Event = CheckpointFact extends infer F ? (F extends CheckpointFact ? Omit<F, 'activityId' | 'contextId' | 'owner' | 'recovering' | 'sequence' | 'occurredAt'> : never) : never;
const active = new WeakMap<object, Set<string>>();

/** One activity coordinates declared capture, durable storage and separate passive facts. */
export class InvocationCheckpoint<Input, Output, Context extends InvocationContext<Input, Output>> {
  readonly activityId = randomUUID();
  readonly observation: InvocationObservation;
  #sequence = 0;
  #head?: CheckpointHead;
  #claimed = false;
  #ready = false;
  #terminal = false;
  #restore?: CheckpointHead;
  readonly #savedChildren = new Map<string, CheckpointChild>();
  readonly #resumedChildren = new Map<string, InvocationTarget>();
  readonly #observer?: ObserverSession<{ observe(fact: CheckpointFact): void; available?(): boolean }>;
  constructor(
    private readonly invocation: Invocation<Input, Output, Context>,
    private readonly installation: CheckpointInstallation,
    private readonly work: InvocationCheckpointWork<Input, Output, Context> | undefined,
    private readonly signal: AbortSignal,
    restore?: CheckpointRestoration,
  ) {
    this.#observer = installation.observation ? new ObserverSession({ observe: (fact: CheckpointFact) => installation.observation!.observe(fact), available: () => true }, installation.observation.failure ?? 'isolate') : undefined;
    this.observation = new InvocationObservation(
      [
        new ObserverSession<InvocationObserver>(
          {
            observe: (fact) => this.emit({ kind: 'activity', fact }),
            resource: (fact) => this.emit({ kind: 'resource', fact }),
            transcript: (fact) => this.emit({ kind: 'transcript', fact }),
            memory: (fact) => this.emit({ kind: 'memory', fact }),
          },
          'propagate',
        ),
      ],
      new Map(),
    );
    if (restore) {
      this.#restore = cloneCheckpointHead(restore.head);
      this.#head = this.#restore;
      const image = this.#restore.image;
      if (!work || this.#restore.delivery || image.contract.key !== work.key || image.contract.version !== work.version || !isEqual(image.frame.owner, invocation.identity) || image.frame.round > invocation.maxRounds || !work.points[image.point]) throw new Error('Incompatible checkpoint continuation');
      if (invocation.context.progress.round !== image.frame.round || !isEqual(cloneCheckpointValue(work.input.encode(invocation.context.currentInput)), image.frame.currentInput) || !isEqual(cloneCheckpointValue(work.input.encode(invocation.context.input)), image.frame.input)) throw new Error('Checkpoint input changed during binding');
      if (!isEqual(invocation.context.continuation, restoreCheckpointContinuation(image.frame))) throw new Error('Checkpoint continuation changed during binding');
      checkCheckpointReferences(image.frame, image.references, work.points[image.point]!.references);
      const children = image.frame.children.map((child) => decodeCheckpointChild(child, checkpointChildBinding(child, work.children), signal, work.receptions));
      invocation.children.install(image.frame.nextChildOrder, children);
      for (const child of image.frame.children) this.#savedChildren.set(child.identity.contextId, child);
    }
  }
  private emit(event: Event): void {
    const fact = Object.freeze({ ...event, activityId: this.activityId, contextId: this.invocation.context.id, owner: this.invocation.identity, recovering: this.invocation.recovering, sequence: ++this.#sequence, occurredAt: new Date().toISOString() }) as CheckpointFact;
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
    if (!current || current.delivery || current.revision !== this.#restore.revision || current.image.id !== image.id) throw new Error('Checkpoint head changed before continuation');
    const point = this.work!.points[image.point]!;
    const decoded = decodeCheckpointFrame(image.frame, this.work!, this.work!.children, this.work!.receptions);
    checkCheckpointReferences(image.frame, image.references, point.references);
    point.check?.(image.frame, point.state.decode(image.state), image.references, decoded);
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
        try {
          this.invocation.requireActive();
          const context = this.invocation.context;
          if (!this.#claimed || this.#terminal || context.progress.phase !== 'execute' || context.progress.round !== round) throw new Error('Checkpoint writer is outside its executing round');
          const definition = this.work!.points[point];
          if (!definition) throw new Error('Checkpoint point is not declared');
          const children = captureCheckpointChildren(context, this.invocation.children, this.#savedChildren);
          const continuation = captureCheckpointContinuation(context.continuation, children.children);
          const image = cloneCheckpointImage({ id: randomUUID(), formatVersion: 5, contract: { key: this.work!.key, version: this.work!.version }, point, frame: { owner: this.invocation.identity, phase: 'execute', round, input: this.work!.input.encode(context.input), currentInput: this.work!.input.encode(context.currentInput), ...children, ...(continuation ? { continuation } : {}) }, state: definition.state.encode(state), references });
          const decoded = decodeCheckpointFrame(image.frame, this.work!, this.work!.children, this.work!.receptions);
          checkCheckpointReferences(image.frame, image.references, definition.references);
          definition.check?.(image.frame, definition.state.decode(image.state), image.references, decoded);
          this.emit({ kind: 'captured', checkpointId: image.id, point });
          stage = 'save';
          this.#head = cloneCheckpointHead(this.installation.store.save(image, this.#head?.revision ?? 0));
          this.emit({ kind: 'saved', checkpointId: image.id, point });
          return image;
        } catch (error) {
          this.invocation.reject(error);
          try {
            this.emit({ kind: 'failed', stage, error });
          } catch {
            /* Preserve the primary storage/capture failure. */
          }
          throw error;
        }
      },
    });
  }
  async resume(): Promise<Output> {
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
      this.#savedChildren.delete(contextId);
      this.#resumedChildren.set(contextId, target);
      this.emit({ kind: 'child-restored', child: saved, mode: 'continuation' });
      return target;
    }
    const child = restored.child;
    const decoded = decodeCheckpointChild(child, binding, this.signal, this.work?.receptions);
    this.invocation.children.replaceSaved(contextId, decoded.target, decoded.state);
    this.#savedChildren.set(contextId, child);
    this.#resumedChildren.set(contextId, decoded.target);
    this.emit({ kind: 'child-restored', child, mode: 'delivery' });
    return decoded.target;
  }
  finish(result: { status: 'succeeded'; output: Output } | { status: 'failed' | 'cancelled' }): void {
    try {
      this.finalize(result);
    } catch (error) {
      this.reportFailure('finish', error);
      throw error;
    }
  }
  private finalize(result: { status: 'succeeded'; output: Output } | { status: 'failed' | 'cancelled' }): void {
    if (!this.#head || this.#terminal || !this.#claimed || !this.#ready) return;
    const delivery: CheckpointDelivery = result.status === 'succeeded' ? { status: 'succeeded', output: cloneCheckpointValue(this.work!.output.encode(result.output)), progress: { round: this.invocation.context.progress.round, phase: this.invocation.context.progress.phase, currentInput: cloneCheckpointValue(this.work!.input.encode(this.invocation.context.currentInput)) } } : result;
    // Final-delivery checking precedes durable finalization; errors can still be owned here.
    this.emit({ kind: 'finishing', status: delivery.status });
    this.#head = cloneCheckpointHead(this.installation.store.finish(this.invocation.context.id, this.#head.revision, delivery));
    this.#terminal = true;
    // The committed delivery is fixed. A passive post-commit notification cannot rewrite it.
    try {
      this.emit({ kind: 'finished', status: delivery.status });
    } catch {
      /* Consumer is disabled by its session. */
    }
  }
}
