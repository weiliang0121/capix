import { RuntimeError } from '@weiliang0121/capix-contracts';
import { View } from '@weiliang0121/capix-view';

export const createMemory = (content) => ({ action: 'create', memoryId: null, change: 'new understanding', sourceIndexes: [0], result: { topic: 'topic', content, sourceIndexes: [0] } });

// A third source defined by a consumer, not a new production entity or plugin registry.
export function skillSource() {
  let version = 0;
  const values = new Map([
    ['translate', { text: 'Translate faithfully.' }],
    ['review', { text: 'Review the output.' }],
  ]);
  const counts = { index: 0, inspect: 0, read: 0, check: 0 };
  const stamp = () => Object.freeze({ id: 'local-skills', scope: 'whole', version: String(version) });
  const source = {
    index() {
      counts.index++;
      return { stamp: stamp(), entries: [...values.keys()].map((key) => ({ key, summary: { title: key } })) };
    },
    inspect(keys) {
      const expected = stamp();
      counts.inspect++;
      if (!Array.isArray(keys) || new Set(keys).size !== keys.length) throw new TypeError('Skill keys must be a unique array');
      const entries = keys.map((key) => {
        if (!values.has(key)) throw new RangeError('Skill does not exist');
        return { key, summary: { title: key } };
      });
      if (!source.check(expected)) throw new RuntimeError('VIEW_SOURCE_CONFLICT', 'Skills changed');
      return { stamp: expected, entries };
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

export function sourceFor(id, entries, summary, scope = 'whole') {
  const values = new Map(entries);
  const stamp = Object.freeze({ id, scope, version: '0' });
  const check = (expected) => expected.id === id && expected.scope === scope && expected.version === '0';
  const inspect = (keys) => {
    if (!Array.isArray(keys) || new Set(keys).size !== keys.length) throw new TypeError('Keys must be unique');
    return {
      stamp,
      entries: keys.map((key) => {
        if (!values.has(key)) throw new RangeError('Unknown key');
        return { key, summary: summary(values.get(key)) };
      }),
    };
  };
  return {
    index: () => inspect([...values.keys()]),
    inspect,
    check,
    read(keys, expected) {
      if (!check(expected)) throw new RuntimeError('VIEW_SOURCE_CONFLICT', 'Source changed');
      inspect(keys);
      return { stamp, entries: keys.map((key) => ({ key, value: Object.freeze({ ...values.get(key) }) })) };
    },
  };
}
export function scopedSource(source, keys) {
  const scope = JSON.stringify(keys);
  const stamp = (value) => ({ ...value, scope });
  return {
    index: () => {
      const value = source.inspect(keys);
      return { ...value, stamp: stamp(value.stamp) };
    },
    inspect: (selected) => {
      if (selected.some((key) => !keys.includes(key))) throw new RangeError('Outside scope');
      const value = source.inspect(selected);
      return { ...value, stamp: stamp(value.stamp) };
    },
    check: (expected) => expected.scope === scope && source.check({ ...expected, scope: 'whole' }),
    read: (selected, expected) => {
      const value = source.read(selected, { ...expected, scope: 'whole' });
      return { ...value, stamp: stamp(value.stamp) };
    },
  };
}
export function fixture() {
  const memory = { id: 'memory', content: 'An earlier understanding', toJSON: () => ({ id: 'memory', topic: 'topic', content: 'An earlier understanding', sourceIndexes: [0] }) };
  const skill = skillSource();
  const sources = {
    messages: sourceFor(
      'messages',
      [
        [0, { role: 'user', content: 'Original request' }],
        [1, { role: 'assistant', content: 'Original answer' }],
      ],
      (value) => ({ role: value.role }),
    ),
    memories: sourceFor('memories', [['memory', memory.toJSON()]], (value) => ({ topic: value.topic })),
    skills: skill.source,
  };
  const state = {
    revision: 0,
    sources: { messages: { id: 'messages', scope: 'whole' }, memories: { id: 'memories', scope: 'whole' }, skills: { id: 'local-skills', scope: 'whole' } },
    members: [
      { source: 'skills', key: 'translate' },
      { source: 'messages', key: 0 },
      { source: 'memories', key: memory.id },
    ],
  };
  return { memory, skill, sources, state, view: new View(state) };
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const conflict = (error) => error instanceof RuntimeError && ['VIEW_CONFLICT', 'VIEW_SOURCE_CONFLICT'].includes(error.code);
