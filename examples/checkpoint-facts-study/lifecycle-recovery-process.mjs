import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeSync } from 'node:fs';
import { LifecycleAdapter } from './lifecycle-adapter.mjs';
import { lifecycleCodec, lifecycleReception } from './invocation-lifecycle.mjs';

// The event file is diagnostic only. Restore reads the experiment's persisted
// facts through adapter.store, then uses the real public Invocation restore path.
const [mode, path, variant = 'none', requestedRootId] = process.argv.slice(2);
assert.ok(['run', 'resume', 'inspect'].includes(mode));
const cuts = new Set(['waiting-no-child-head', 'child-active', 'child-succeeded', 'parent-receiving', 'parent-accepted', 'parent-handled', 'child-failed', 'child-cancelled', 'root-terminal', 'lost-ack-parent-waiting', 'lost-ack-parent-failed']);
const adversaries = new Set(['none', 'child-owner', 'child-input', 'child-contract', 'root-order', 'root-refs', 'reception-contract']);
assert.ok(mode === 'run' ? cuts.has(variant) : adversaries.has(variant));
const logPath = `${path}.events.jsonl`;
let rootId = requestedRootId;
let childId;
let root;
let adapter;
let readActual;
const childController = new AbortController();
const parentKey = 'study.lifecycle.recovery.parent';
const childKey = 'study.lifecycle.recovery.child';

function event(kind, details = {}) {
  appendFileSync(logPath, `${JSON.stringify({ kind, ...details })}\n`);
}

function events() {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

function report(extra = {}) {
  // These full-head reads are only output diagnostics. They do not seed models,
  // selection state, relations, effects, or the subsequent recovery invocation.
  const savedRoot = rootId ? readActual(rootId) : undefined;
  const savedChildId = childId ?? savedRoot?.image.frame.children[0]?.identity.contextId;
  return { mode, variant, rootId, childId: savedChildId, root: savedRoot ?? null, child: savedChildId ? (readActual(savedChildId) ?? null) : null, events: events(), ...extra };
}

function print(value) {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

function cut(label) {
  print(report({ cut: label }));
  process.exit(73); // Deliberately bypass work, Invocation and adapter finally.
}

adapter = new LifecycleAdapter({
  path,
  beforeFinish(contextId, delivery) {
    if (mode !== 'run') return;
    if (variant === 'lost-ack-parent-waiting' && contextId === rootId && delivery.status === 'failed') cut('lost-ack-parent-waiting');
  },
  afterFinish(contextId, delivery) {
    event('finish-committed', { contextId, status: delivery.status });
    if (mode !== 'run') return;
    if (contextId === childId) {
      if (variant === 'child-succeeded' && delivery.status === 'succeeded') cut(variant);
      if (variant === 'child-failed' && delivery.status === 'failed') cut(variant);
      if (variant === 'child-cancelled' && delivery.status === 'cancelled') cut(variant);
      if (variant.startsWith('lost-ack-') && delivery.status === 'succeeded') throw new Error('Child finish committed but acknowledgement was lost');
    }
    if (variant === 'lost-ack-parent-failed' && contextId === rootId && delivery.status === 'failed') cut(variant);
  },
});
readActual = adapter.store.read.bind(adapter.store);

const childBinding = {
  key: childKey,
  version: 1,
  input: lifecycleCodec,
  output: lifecycleCodec,
  points: {
    prepared: {
      state: lifecycleCodec,
      execute(_context, _invocation, state) {
        event('child-resume');
        return state;
      },
    },
  },
};
const reception = lifecycleReception();
// Both contracts are registered in both processes. The rejection below must be
// about changing an already selected reception, not an unknown declaration.
const alternateReception = lifecycleReception(1, 0);
const references = { child: { cardinality: 'one', position: 0 } };

function reference(parent, child) {
  const relation = parent.children.get(child);
  return { contextId: child.context.id, parentContextId: parent.context.id, parentRound: relation.round, order: relation.order, target: { position: relation.declarationPosition } };
}

function checkPoint(expected) {
  return (frame, state, refs) => {
    assert.equal(frame.children.length, 1);
    assert.equal(refs.child.contextId, state.childId);
    assert.equal(frame.children[0].identity.contextId, state.childId);
    const saved = frame.children[0].state;
    if (expected === 'waiting') assert.equal(saved.kind, 'waiting');
    else assert.equal(saved.reception.kind, expected);
  };
}

function save(parent, child, point, output) {
  return parent.checkpointWriter.save(point, { childId: child.context.id, ...(output === undefined ? {} : { output }) }, { child: reference(parent, child) });
}

async function receive(parent, child) {
  const relation = parent.children.get(child);
  try {
    await child.run();
  } catch (error) {
    if (mode !== 'run' || variant !== 'parent-handled') throw error;
    const output = await relation.handle(() => {
      event('handled-mapping');
      return { answer: 'fallback' };
    }, reception);
    save(parent, child, 'handled', output);
    cut('parent-handled');
  }
  const output = await relation.accept(
    (value) => {
      event('acceptance-begin');
      if (mode === 'run' && variant === 'parent-receiving') {
        save(parent, child, 'receiving');
        cut('parent-receiving');
      }
      event('accepted-mapping');
      return { answer: value.text };
    },
    variant === 'reception-contract' ? alternateReception : reception,
  );
  save(parent, child, 'accepted', output);
  if (mode === 'run' && variant === 'parent-accepted') cut('parent-accepted');
  return output;
}

const parentBinding = {
  key: parentKey,
  version: 1,
  input: lifecycleCodec,
  output: lifecycleCodec,
  children: [{ kind: 'node', binding: childBinding }],
  receptions: [reception, alternateReception],
  points: {
    waiting: {
      state: lifecycleCodec,
      references,
      check: checkPoint('waiting'),
      execute(_context, invocation, state, refs) {
        event('parent-resume', { point: 'waiting' });
        const child = invocation.restoreChild(0, refs.child.contextId, () => {
          event('child-resume-created');
          return adapter.resume(refs.child.contextId, { binding: childBinding, parent: invocation });
        });
        assert.equal(child.context.id, state.childId);
        return receive(invocation, child);
      },
    },
    receiving: {
      state: lifecycleCodec,
      references,
      check: checkPoint('receiving'),
      execute(_context, invocation, state, refs) {
        event('parent-resume', { point: 'receiving' });
        const child = invocation.restoreChild(0, refs.child.contextId, () => {
          event('child-resume-created');
          return adapter.resume(refs.child.contextId, { binding: childBinding, parent: invocation });
        });
        assert.equal(child.context.id, state.childId);
        return receive(invocation, child);
      },
    },
    accepted: {
      state: lifecycleCodec,
      references,
      check: checkPoint('accepted'),
      execute(_context, invocation, state) {
        event('parent-resume', { point: 'accepted' });
        const relation = invocation.children.values()[0];
        assert.equal(relation.reception.status, 'accepted');
        assert.deepEqual(relation.reception.output, state.output);
        return state.output;
      },
    },
    handled: {
      state: lifecycleCodec,
      references,
      check: checkPoint('handled'),
      execute(_context, invocation, state) {
        event('parent-resume', { point: 'handled' });
        const relation = invocation.children.values()[0];
        assert.equal(relation.returned.status, 'failed');
        assert.equal(relation.reception.status, 'handled');
        assert.deepEqual(relation.reception.output, state.output);
        return state.output;
      },
    },
  },
};

function createRoot() {
  return adapter.create({
    input: { query: 'one' },
    kind: 'group',
    binding: parentBinding,
    async execute(_context, invocation) {
      event('parent-body');
      const child = adapter.create({
        parent: invocation,
        input: { query: 'one' },
        binding: childBinding,
        receiveFailure: true,
        signal: childController.signal,
        execute(context, childInvocation) {
          event('child-body');
          const output = { text: `effect:${context.input.query}` };
          event('effect', { output });
          childInvocation.checkpointWriter.save('prepared', output);
          if (variant === 'child-active') cut(variant);
          if (variant === 'parent-handled' || variant === 'child-failed') throw new Error('Business child failed');
          if (variant === 'child-cancelled') childController.abort(new Error('Child cancelled'));
          return output;
        },
      });
      childId = child.context.id;
      save(invocation, child, 'waiting');
      if (variant === 'waiting-no-child-head') cut(variant);
      return receive(invocation, child);
    },
  });
}

// Adversarial variants alter only a public read result. They never edit SQLite
// or create substitute recovery facts, and must be rejected by real restoration.
if (mode === 'resume' && variant !== 'none' && variant !== 'reception-contract') {
  adapter.store.read = (id) => {
    const head = readActual(id);
    if (!head) return head;
    const changed = structuredClone(head);
    if (id === rootId) {
      if (variant === 'root-order') changed.image.frame.children[0].order += 7;
      if (variant === 'root-refs') changed.image.references.child.contextId = 'foreign-child';
    } else {
      if (variant === 'child-owner') changed.image.frame.owner.parentContextId = 'foreign-parent';
      if (variant === 'child-input') changed.image.frame.input = { query: 'different' };
      if (variant === 'child-contract') changed.image.contract.version++;
    }
    return changed;
  };
}

try {
  if (mode === 'inspect') print(report({ inspected: true }));
  else {
    root = mode === 'run' ? createRoot() : adapter.resume(rootId, { binding: parentBinding });
    rootId = root.context.id;
    const result = await root.run();
    print(report({ result }));
  }
} catch (error) {
  print(report({ error: { name: error.name, code: error.code, message: error.message } }));
  process.exitCode = 1;
} finally {
  adapter.close();
}
