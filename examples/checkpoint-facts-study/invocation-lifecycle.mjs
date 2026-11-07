import { Invocation, InvocationContext, InvocationObservation, ObserverSession } from '@capix/invocation';
import { MemoryCheckpointStore } from '@capix/checkpoint';

// Measurement only: this module does not install StableValues, replace production
// codecs, or infer a Frame from observer events. A Store wrapper records the real
// committed images; explicit samples inspect the actual Context and relation.
export const lifecycleCodec = { encode: (value) => value, decode: (value) => value };

export function lifecycleBinding(key, { children = [], receptions = [] } = {}) {
  return {
    key,
    version: 1,
    input: lifecycleCodec,
    output: lifecycleCodec,
    children,
    receptions,
    points: {
      checkpoint: {
        state: lifecycleCodec,
        execute() {
          throw new Error('Lifecycle probe does not restore an invocation');
        },
      },
    },
  };
}

export function lifecycleReception(position = 0, childPosition = 0) {
  return { position, childPosition, codec: lifecycleCodec, check() {} };
}

export class InvocationLifecycleProbe {
  memory = new MemoryCheckpointStore();
  timeline = [];
  signal = new AbortController().signal;
  afterFinish;

  constructor() {
    this.store = {
      read: (id) => this.memory.read(id),
      save: (image, revision) => {
        this.record({ kind: 'store.save.enter', contextId: image.frame.owner.contextId, image });
        const receipt = this.memory.save(image, revision);
        this.record({ kind: 'store.save.committed', contextId: image.frame.owner.contextId, receipt });
        return receipt;
      },
      finish: (contextId, revision, delivery) => {
        this.record({ kind: 'store.finish.enter', contextId, delivery });
        const receipt = this.memory.finish(contextId, revision, delivery);
        this.record({ kind: 'store.finish.committed', contextId, delivery, receipt });
        // A real commit followed by a lost acknowledgement is deliberately
        // injected outside MemoryCheckpointStore, not simulated in its data.
        this.afterFinish?.(contextId, delivery);
        return receipt;
      },
    };
  }

  record(event) {
    // Copies are diagnostic snapshots of borrowed observation values, not
    // stable production values or a new trusted checkpoint representation.
    this.timeline.push(structuredClone(event));
  }

  create({ input = null, parent, position = 0, key, receiveFailure = false, binding, execute, close, observe }) {
    const context = new InvocationContext(input);
    const sessions = [new ObserverSession({ observe: (fact) => this.record({ kind: 'observation', fact }) }, 'propagate')];
    if (observe) sessions.push(new ObserverSession({ observe }, 'propagate'));
    const invocation = new Invocation({
      context,
      signal: this.signal,
      identity: { contextId: context.id, kind: parent ? 'node' : 'group', ...(parent ? { parentContextId: parent.context.id } : {}) },
      ...(parent ? { parent: { invocation: parent, declarationPosition: position, receiveFailure, ...(key === undefined ? {} : { key }) } } : {}),
      observation: new InvocationObservation(sessions, new Map()),
      ...(binding ? { checkpoints: { store: this.store, observation: { observe: (fact) => this.record({ kind: 'checkpoint', fact }) } } } : {}),
      work: { execute, ...(close ? { close } : {}), ...(binding ? { checkpoint: binding } : {}) },
    });
    return invocation;
  }

  sample(label, invocation, child) {
    const relation = child ? invocation.children.get(child) : undefined;
    const reception = relation?.reception;
    const sample = {
      kind: 'sample',
      label,
      contextId: invocation.context.id,
      state: invocation.context.state,
      progress: invocation.context.progress,
      ...(relation
        ? {
            relation: {
              identity: child.identity,
              order: relation.order,
              parentRound: relation.round,
              position: relation.declarationPosition,
              key: relation.key,
              input: child.context.input,
              returned: relation.returned,
              reception: {
                status: reception.status,
                ...('output' in reception ? { output: reception.output } : {}),
                ...('error' in reception ? { error: reception.error } : {}),
                ...('failure' in reception ? { failure: reception.failure } : {}),
                ...(reception.contract ? { contract: { position: reception.contract.position, childPosition: reception.contract.childPosition } } : {}),
              },
            },
          }
        : {}),
    };
    this.record(sample);
    return this.timeline.at(-1);
  }

  save(invocation, label, child) {
    this.sample(label, invocation, child);
    return invocation.checkpointWriter.save('checkpoint', { label });
  }

  events(contextId) {
    return this.timeline.filter((event) => event.kind === 'observation' && event.fact.identity.contextId === contextId).map((event) => event.fact);
  }

  images(contextId) {
    return this.timeline.filter((event) => event.kind === 'store.save.enter' && event.contextId === contextId).map((event) => event.image);
  }

  async run(invocation) {
    try {
      const output = await invocation.run();
      this.record({ kind: 'run.delivered', contextId: invocation.context.id, status: 'succeeded', output });
      return output;
    } catch (error) {
      this.record({ kind: 'run.delivered', contextId: invocation.context.id, status: 'failed', error });
      throw error;
    }
  }
}
