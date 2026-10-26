import { RuntimeError } from '@capix/contracts';
import { Transcript, TranscriptViewSource } from '@capix/transcript';
import { Memories, MemoryViewSource } from '@capix/memory';
import { View } from '@capix/view';

export const createMemory = (content) => ({ action: 'create', memoryId: null, change: 'new understanding', sourceIndexes: [0], result: { topic: 'topic', content, sourceIndexes: [0] } });

// A third source defined by a consumer, not a new production entity or plugin registry.
export function skillSource() {
  let version = 0;
  const values = new Map([
    ['translate', { text: 'Translate faithfully.' }],
    ['review', { text: 'Review the output.' }],
  ]);
  const counts = { index: 0, read: 0, check: 0 };
  const stamp = () => Object.freeze({ id: 'local-skills', scope: 'whole', version: String(version) });
  const source = {
    index() {
      counts.index++;
      return { stamp: stamp(), entries: [...values.keys()].map((key) => ({ key, summary: { title: key } })) };
    },
    read(keys, expected) {
      if (!source.check(expected)) throw new RuntimeError('VIEW_SOURCE_CONFLICT', 'Skills changed');
      counts.read++;
      return {
        stamp: stamp(),
        entries: keys.map((key) => {
          if (!values.has(key)) throw new RangeError('Skill does not exist');
          return { key, value: Object.freeze({ ...values.get(key) }) };
        }),
      };
    },
    check(expected) {
      counts.check++;
      return expected.id === 'local-skills' && expected.scope === 'whole' && expected.version === String(version);
    },
  };
  return {
    source,
    counts,
    replace(key, text) {
      values.set(key, { text });
      version++;
    },
  };
}

export function fixture() {
  const transcript = new Transcript([
    { role: 'user', content: 'Original request' },
    { role: 'assistant', content: 'Original answer' },
  ]);
  const memories = new Memories(transcript);
  const [memory] = memories.apply([createMemory('An earlier understanding')]);
  const skill = skillSource();
  const sources = { messages: new TranscriptViewSource(transcript), memories: new MemoryViewSource(memories), skills: skill.source };
  const state = {
    revision: 0,
    sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' }, skills: { id: 'local-skills', scope: 'whole' } },
    members: [
      { source: 'skills', key: 'translate' },
      { source: 'messages', key: 0 },
      { source: 'memories', key: memory.id },
    ],
  };
  return { transcript, memories, memory, skill, sources, state, view: new View(state) };
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const conflict = (error) => error instanceof RuntimeError && ['VIEW_CONFLICT', 'VIEW_SOURCE_CONFLICT'].includes(error.code);
