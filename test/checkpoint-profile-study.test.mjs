import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeCpuProfile } from '../examples/tool-host-study/cpu-profile.mjs';

const invocation = 'file:///repo/server/invocation/dist/checkpoint/invocation.js';
const children = 'file:///repo/server/invocation/dist/checkpoint/children.js';
const facts = 'file:///repo/server/invocation/dist/checkpoint/facts.js';
const values = 'file:///repo/server/checkpoint/dist/value.js';
const store = 'file:///repo/services/conversation/dist/persistence/checkpoints.js';
const storage = 'file:///repo/services/conversation/dist/persistence/checkpoint-storage.js';
const study = 'file:///repo/examples/tool-host-study/run.mjs';

function profile(paths) {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [] }];
  const samples = [];
  const timeDeltas = [];
  for (const { frames, us = 1000 } of paths) {
    let parent = nodes[0];
    for (const [functionName, url = ''] of frames) {
      const node = { id: nodes.length + 1, callFrame: { functionName, url, lineNumber: 0 }, children: [] };
      nodes.push(node);
      parent.children.push(node.id);
      parent = node;
    }
    samples.push(parent.id);
    timeDeltas.push(us);
  }
  return { nodes, samples, timeDeltas, startTime: 1000, endTime: 1000 + timeDeltas.reduce((total, value) => total + value, 0) };
}

test('checkpoint profile phases own nested work and count every sample once', () => {
  const source = profile([
    {
      frames: [
        ['save', invocation],
        ['save', study],
        ['save', store],
        ['readCurrent', store],
        ['decodeHead', store],
        ['cloneCheckpointImage', values],
        ['visit', values],
      ],
      us: 5000,
    },
    {
      frames: [
        ['save', invocation],
        ['save', study],
        ['save', store],
        ['encodeCheckpointStorage', storage],
        ['brotliCompressSync', 'node:zlib'],
      ],
      us: 3000,
    },
    {
      frames: [
        ['save', invocation],
        ['captureCheckpointChildren', children],
        ['cloneCheckpointValue', values],
        ['visit', values],
      ],
      us: 2000,
    },
    {
      frames: [
        ['save', invocation],
        ['decodeCheckpointFrame', facts],
        ['parse', 'file:///repo/node_modules/zod/index.js'],
      ],
      us: 1000,
    },
    {
      frames: [
        ['save', invocation],
        ['cloneCheckpointImage', values],
        ['visit', values],
      ],
      us: 4000,
    },
    {
      frames: [
        ['save', invocation],
        ['save', study],
        ['save', store],
        ['run', 'node:sqlite'],
      ],
      us: 2000,
    },
    { frames: [['save', invocation], ['save', study], ['stringify']], us: 1000 },
    {
      frames: [
        ['save', invocation],
        ['encode', 'file:///repo/business/codec.js'],
      ],
      us: 1000,
    },
    { frames: [['(garbage collector)']], us: 1000 },
    { frames: [['(idle)']], us: 3000 },
    {
      frames: [
        ['save', 'file:///repo/business/ordinary.js'],
        ['parse', 'file:///repo/node_modules/zod/index.js'],
      ],
      us: 1000,
    },
  ]);
  const result = summarizeCpuProfile(source);
  const rows = Object.fromEntries(result.buckets.map((row) => [row.kind, row]));
  assert.equal(result.samples, 11);
  assert.equal(result.sampleMs, 24);
  assert.equal(result.durationMinusSampleMs, 0);
  assert.equal(
    result.buckets.reduce((total, row) => total + row.samples, 0),
    result.samples,
  );
  assert.equal(
    result.buckets.reduce((total, row) => total + row.sampleMs, 0),
    result.sampleMs,
  );
  assert.ok(Math.abs(result.buckets.reduce((total, row) => total + row.percent, 0) - 100) < 1e-10);
  assert.deepEqual(Object.fromEntries(result.buckets.map((row) => [row.kind, row.sampleMs])), { 'old-head-read': 5, 'storage-encode': 3, 'child-capture': 2, 'frame-decode': 1, 'image-certification': 4, 'checkpoint-store': 2, 'study-bookkeeping': 1, 'invocation-checkpoint': 1, gc: 1, idle: 3, unclassified: 1 });
  assert.equal(rows['old-head-read'].samples, 1);
  assert.equal(rows['image-certification'].samples, 1, 'nested read-head certification must not be counted here');
  assert.equal(result.unclassifiedTopFrames.length, 1);
  assert.equal(result.unclassifiedTopFrames[0].functionName, 'parse');
});

test('checkpoint profile retains unresolved and idle samples instead of assigning them to CP', () => {
  const source = profile([
    { frames: [['(program)']], us: 2000 },
    { frames: [['save', invocation], ['(idle)']], us: 3000 },
  ]);
  source.samples.push(999);
  source.timeDeltas.push(4000);
  source.endTime += 4500;
  const result = summarizeCpuProfile(source);
  assert.equal(result.buckets.find((row) => row.kind === 'unclassified').sampleMs, 6);
  assert.equal(result.buckets.find((row) => row.kind === 'idle').sampleMs, 3);
  assert.equal(result.buckets.find((row) => row.kind === 'invocation-checkpoint').sampleMs, 0);
  assert.equal(result.durationMinusSampleMs, 0.5);
  assert.ok(result.unclassifiedTopFrames.some((frame) => frame.functionName === '(missing node)'));
});

test('empty checkpoint profiles have finite zero percentages; malformed weights are rejected', () => {
  const empty = summarizeCpuProfile(profile([]));
  assert.equal(empty.sampleMs, 0);
  assert.ok(empty.buckets.every((row) => row.percent === 0 && row.samples === 0));
  const source = profile([{ frames: [['(program)']] }]);
  assert.throws(() => summarizeCpuProfile({ ...source, timeDeltas: [] }), /samples and time deltas differ/);
  assert.throws(() => summarizeCpuProfile({ ...source, timeDeltas: [-1] }), /invalid time delta/);
});
