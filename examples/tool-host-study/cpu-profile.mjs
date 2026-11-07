import { Session } from 'node:inspector/promises';

const samplingIntervalUs = 1000;
const descriptions = {
  'old-head-read': 'Read and decode the previous durable head, including decompression and certification',
  'storage-encode': 'Serialize, compress and encode new checkpoint storage',
  'child-capture': 'Capture child relationships, including their codecs and pure-value copies',
  'frame-decode': 'Decode the fixed Frame and check decoded reception values',
  'image-certification': 'Copy and certify a whole image or final delivery outside the preceding phases',
  'checkpoint-store': 'Remaining checkpoint Store work, including SQL, CAS and transaction work',
  'study-bookkeeping': 'Study save/finish wrappers after excluding actual checkpoint work',
  'invocation-checkpoint': 'Remaining invocation checkpoint work: own codecs, point checks, references and receipts',
  gc: 'V8 garbage-collection samples; not allocated to the triggering operation',
  idle: 'V8 idle samples',
  unclassified: 'Other execution or samples without a recognized checkpoint stack',
};

/** Opt-in, local diagnostic only. No source rewriting or runtime instrumentation. */
export async function startCpuProfile() {
  const session = new Session();
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
    await session.post('Profiler.start');
  } catch (error) {
    session.disconnect();
    throw error;
  }
  let stopped = false;
  return {
    async stop() {
      if (stopped) throw new Error('CPU profile has already stopped');
      stopped = true;
      try {
        const { profile } = await session.post('Profiler.stop');
        return { profile, summary: { samplingIntervalUs, ...summarizeCpuProfile(profile) } };
      } finally {
        session.disconnect();
      }
    },
  };
}

/** Assign each sample once, with outer CP phases taking ownership of nested work. */
export function summarizeCpuProfile(profile) {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  if (samples.length !== deltas.length) throw new Error('CPU profile samples and time deltas differ');
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const classifications = new Map();
  const buckets = Object.fromEntries(Object.entries(descriptions).map(([kind, description]) => [kind, { kind, description, samples: 0, sampleMs: 0, percent: 0 }]));
  const unknown = new Map();
  let sampledUs = 0;
  for (let index = 0; index < samples.length; index++) {
    const id = samples[index];
    const delta = deltas[index];
    if (!Number.isFinite(delta) || delta < 0) throw new Error('CPU profile contains an invalid time delta');
    let kind = classifications.get(id);
    if (!kind) {
      kind = classify(stack(id, nodes, parents));
      classifications.set(id, kind);
    }
    const row = buckets[kind];
    row.samples += 1;
    row.sampleMs += delta / 1000;
    sampledUs += delta;
    if (kind === 'unclassified') {
      const frame = nodes.get(id)?.callFrame;
      const key = JSON.stringify([frame?.url ?? '', frame?.functionName ?? '(missing node)', frame?.lineNumber ?? -1]);
      const item = unknown.get(key) ?? { functionName: frame?.functionName ?? '(missing node)', url: frame?.url ?? '', lineNumber: frame?.lineNumber ?? -1, samples: 0, sampleMs: 0 };
      item.samples += 1;
      item.sampleMs += delta / 1000;
      unknown.set(key, item);
    }
  }
  const sampleMs = sampledUs / 1000;
  for (const row of Object.values(buckets)) row.percent = sampleMs === 0 ? 0 : (row.sampleMs / sampleMs) * 100;
  const profileDurationMs = (profile.endTime - profile.startTime) / 1000;
  return {
    samples: samples.length,
    sampleMs,
    profileDurationMs,
    durationMinusSampleMs: profileDurationMs - sampleMs,
    buckets: Object.values(buckets),
    unclassifiedTopFrames: [...unknown.values()].sort((left, right) => right.sampleMs - left.sampleMs).slice(0, 20),
    note: 'V8 sampling estimates, weighted by timeDeltas; not exact stage CPU/wall time or invocation counts. Buckets are mutually exclusive and percentages include idle, GC and unclassified samples. Native work is attributed only when its stack retains a recognized caller. Profile start/stop and sampling perturb execution. The retained raw profile is authoritative; unresolved samples are not inferred as CP cost.',
  };
}

function stack(id, nodes, parents) {
  const frames = [];
  const visited = new Set();
  let current = id;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const node = nodes.get(current);
    if (node) frames.push(node.callFrame);
    current = parents.get(current);
  }
  return frames;
}

function classify(frames) {
  const has = (path, names) => frames.some((frame) => path.test(frame.url) && (!names || names.includes(frame.functionName)));
  if (frames.some((frame) => frame.functionName === '(garbage collector)')) return 'gc';
  if (frames.some((frame) => frame.functionName === '(idle)')) return 'idle';
  // URL and function are both necessary: a business function named save/decode is
  // not evidence of CP work. Priority prevents nested certification being counted twice.
  if (has(/\/services\/conversation\/(?:src|dist)\/persistence\/checkpoints\.[jt]s$/, ['readCurrent', 'decodeHead'])) return 'old-head-read';
  if (has(/\/services\/conversation\/(?:src|dist)\/persistence\/checkpoint-storage\.[jt]s$/, ['encodeCheckpointStorage', 'encode'])) return 'storage-encode';
  if (has(/\/server\/invocation\/(?:src|dist)\/checkpoint\/children\.[jt]s$/, ['captureCheckpointChildren', 'captureCheckpointChild', 'captureChildProgress'])) return 'child-capture';
  if (has(/\/server\/invocation\/(?:src|dist)\/checkpoint\/facts\.[jt]s$/, ['decodeCheckpointFrame'])) return 'frame-decode';
  if (has(/\/server\/checkpoint\/(?:src|dist)\/value\.[jt]s$/, ['cloneCheckpointImage', 'cloneCheckpointDelivery', 'cloneCheckpointHead'])) return 'image-certification';
  if (has(/\/services\/conversation\/(?:src|dist)\/persistence\/checkpoints\.[jt]s$/)) return 'checkpoint-store';
  if (has(/\/examples\/tool-host-study\/run\.mjs$/, ['save', 'finish'])) return 'study-bookkeeping';
  if (has(/\/server\/invocation\/(?:src|dist)\/checkpoint\/invocation\.[jt]s$/)) return 'invocation-checkpoint';
  return 'unclassified';
}
