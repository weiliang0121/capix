import { randomUUID } from 'node:crypto';
import { Transcript, TranscriptViewSource } from '@capix/transcript';
import { Memories, MemoryViewSource } from '@capix/memory';
import { View, openView } from '@capix/view';
import { Resource, ResourceOffer } from '@capix/resources';
import { conditions } from './fixtures.mjs';

// Skill 在这个实验中只是一个静态来源，尚不是框架的新实体或执行平台。
function skillSource(skills) {
  const stamp = Object.freeze({ id: randomUUID(), scope: 'whole', version: '1' });
  const values = new Map(skills.map((skill) => [skill.key, Object.freeze({ title: skill.title, instructions: skill.instructions })]));
  if (values.size !== skills.length) throw new TypeError('Duplicate skill key');
  const check = (value) => value?.id === stamp.id && value.scope === stamp.scope && value.version === stamp.version;
  return Object.freeze({
    id: stamp.id,
    scope: stamp.scope,
    check,
    index: () => ({ stamp, entries: [...values].map(([key, value]) => ({ key, summary: { title: value.title } })) }),
    inspect(keys) {
      if (!Array.isArray(keys) || new Set(keys).size !== keys.length) throw new TypeError('Skill keys must be a unique array');
      return {
        stamp,
        entries: keys.map((key) => {
          const value = values.get(key);
          if (!value) throw new RangeError('Skill does not exist in this source scope');
          return { key, summary: { title: value.title } };
        }),
      };
    },
    read(keys, basis) {
      if (!check(basis) || new Set(keys).size !== keys.length || keys.some((key) => !values.has(key))) throw new Error('Invalid skill view selection');
      return { stamp, entries: keys.map((key) => ({ key, value: values.get(key) })) };
    },
  });
}

export const MaterialResource = new ResourceOffer({
  name: 'intent.material',
  expose: ({ view, sources }, activity) => openView(view, sources, activity),
});

export function createMaterial(fixture, condition) {
  if (!Object.hasOwn(conditions, condition)) throw new TypeError(`Unknown condition: ${condition}`);
  const transcript = new Transcript(fixture.messages);
  const memories = new Memories(transcript);
  memories.apply(fixture.memories.map((memory) => ({ action: 'create', memoryId: null, change: '装载实验预先给定的记忆', sourceIndexes: memory.sourceIndexes, result: memory })));
  const sources = {
    messages: new TranscriptViewSource(transcript, fixture.historyIndexes),
    memories: new MemoryViewSource(memories),
    skills: skillSource(fixture.skills),
  };
  const view = new View({
    revision: 0,
    sources: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, { id: source.id, scope: source.scope }])),
    members: conditions[condition].flatMap((name) => sources[name].index().entries.map(({ key }) => ({ source: name, key }))),
  });
  return new Resource({ view, sources });
}

// 取值之后再投影给模型：保留可引用位置；不复制内部 UUID 或整份实体状态。
export function projectMaterial(snapshot) {
  const counts = new Map();
  return snapshot.entries.map(({ source, key, value }) => {
    const ordinal = counts.get(source) ?? 0;
    counts.set(source, ordinal + 1);
    const ref = `${source}:${ordinal}`;
    if (source === 'messages') return { ref, source, index: key, role: value.role, content: value.content };
    if (source === 'memories') return { ref, source, topic: value.topic, content: value.content };
    return { ref, source, title: value.title, instructions: value.instructions };
  });
}
