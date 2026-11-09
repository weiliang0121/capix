import { Invocation, InvocationContext, invocationResourceFailures } from '@weiliang0121/capix-invocation';
import { Memories, MemoryResource } from '@weiliang0121/capix-memory';
import { Resource, Resources } from '@weiliang0121/capix-resources';
import { Transcript } from '@weiliang0121/capix-transcript';

// Isolated probes of existing public contracts. No action abstraction, checkpoint
// installation, draft persistence, resource capability grades, or generic retry.
export function memoryCreate(content) {
  return { action: 'create', memoryId: null, change: 'resource contract study', sourceIndexes: [0], result: { topic: 'study', content, sourceIndexes: [0] } };
}

export function memoryUpdate(memory, content) {
  return { ...memoryCreate(content), action: 'update', memoryId: memory.id };
}

export function memoryBasis(memories) {
  return Object.freeze({ memoriesId: memories.id, transcriptId: memories.transcript.id, sequence: memories.sequence });
}

export function resourceOwner(contextId, facts = []) {
  return {
    contextId,
    failures: invocationResourceFailures,
    validate() {},
    observation: {
      publish(fact) {
        facts.push(fact);
      },
    },
  };
}

export function memoryFixture(options = {}) {
  const transcript = options.transcript ?? new Transcript([{ role: 'user', content: 'Evidence for the resource contract study.' }]);
  const commits = [];
  const events = [];
  const entityOptions = {
    persistence: {
      // A synchronous in-memory commit recorder, not a durable database. Tests
      // below use public export/restore to check only entity reconstruction.
      commit(change) {
        commits.push(structuredClone(change));
      },
    },
    observation: {
      publish(event) {
        events.push(event);
        options.publish?.(event);
      },
    },
  };
  const memories = options.state ? Memories.restore(options.state, transcript, entityOptions) : new Memories(transcript, entityOptions);
  const registry = new Resources().register(new Resource(memories), MemoryResource.apply);
  const binding = registry.bind({ memories: MemoryResource.apply.request() });
  return { transcript, memories, registry, binding, commits, events };
}

/** A real Invocation with a real resource window; the origin still owns effects. */
export function resourceInvocation(binding, execute) {
  const context = new InvocationContext(null);
  const controller = new AbortController();
  const resourceFacts = [];
  let access;
  const invocation = new Invocation({
    context,
    signal: controller.signal,
    work: {
      execute(_context, current) {
        access = binding.open({
          ...resourceOwner(current.context.id, resourceFacts),
          signal: controller.signal,
          validate: () => current.requireActive(),
          error: (error, allowException) => current.reject(error, allowException),
        });
        return execute(access.endpoints, current);
      },
      close() {
        access?.close();
        return { status: 'succeeded', value: undefined };
      },
    },
  });
  return { invocation, resourceFacts };
}
