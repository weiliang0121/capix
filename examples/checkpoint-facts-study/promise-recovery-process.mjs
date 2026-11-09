import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Resource, ResourceOffer, Resources } from '@weiliang0121/capix-resources';
import { LifecycleAdapter } from './lifecycle-adapter.mjs';
import { lifecycleCodec, lifecycleReception } from './invocation-lifecycle.mjs';
import { StableValues } from './stable.mjs';

// Isolated host/resource policy fixture. The invocation store and resource use
// DIFFERENT databases and transactions. The public resource endpoint provides
// either ordinary append or exact confirmation; CP never invents that promise.
const [mode, path, policy, requestedRootId] = process.argv.slice(2);
assert.ok(['run', 'resume'].includes(mode));
assert.ok(['plain', 'refuse', 'confirmed', 'changed-request', 'missing-receipt'].includes(policy));
const logPath = `${path}.events.jsonl`;
const resourcePath = `${path}.resource.sqlite`;
const resourceDb = new DatabaseSync(resourcePath);
resourceDb.exec('PRAGMA synchronous = FULL');
resourceDb.exec('CREATE TABLE IF NOT EXISTS effects (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
resourceDb.exec('CREATE TABLE IF NOT EXISTS receipts (operation TEXT PRIMARY KEY, request TEXT NOT NULL, effect_id INTEGER NOT NULL REFERENCES effects(id))');
const adapter = new LifecycleAdapter({ path });
const fixed = new StableValues();
let rootId = requestedRootId;
let childId;

function event(kind, value = {}) {
  appendFileSync(logPath, `${JSON.stringify({ kind, ...value })}\n`);
}

function report(extra = {}) {
  const head = rootId ? adapter.store.read(rootId) : undefined;
  const actualChildId = childId ?? head?.image.frame.children[0]?.identity.contextId;
  return {
    mode,
    policy,
    rootId,
    childId: actualChildId,
    root: head,
    child: actualChildId ? adapter.store.read(actualChildId) : undefined,
    effects: resourceDb.prepare('SELECT id, body FROM effects ORDER BY id').all(),
    receipts: resourceDb.prepare('SELECT operation, request, effect_id FROM receipts ORDER BY operation').all(),
    events: existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    ...extra,
  };
}

function print(value) {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

function afterResourceCommit() {
  event('resource-committed');
  if (mode === 'run') {
    print(report({ cut: 'effect-committed-before-resource-delivery' }));
    process.exit(73); // No resource, receiver, Invocation or host finally runs.
  }
}

// The receipt table belongs exclusively to this resource implementation. Its
// exact-key semantics are an explicit fixture contract, not a resource baseline.
const effects = {
  append(request) {
    const result = resourceDb.prepare('INSERT INTO effects(body) VALUES (?)').run(JSON.stringify(request));
    afterResourceCommit();
    return { id: Number(result.lastInsertRowid), text: request.text };
  },
  confirmOrAppend(operation, request) {
    const serialized = JSON.stringify(request);
    const previous = resourceDb.prepare('SELECT request, effect_id FROM receipts WHERE operation = ?').get(operation);
    if (previous) {
      assert.equal(previous.request, serialized, 'Resource rejects a changed request under the same operation');
      const effect = resourceDb.prepare('SELECT body FROM effects WHERE id = ?').get(previous.effect_id);
      assert.ok(effect, 'Resource receipt refers to a missing effect');
      assert.equal(effect.body, serialized, 'Resource effect differs from its receipt');
      event('resource-confirmed', { operation });
      return { id: previous.effect_id, text: request.text };
    }
    // For a cold continuation this fixture explicitly refuses when its own
    // confirmation evidence disappeared. It does not infer absence of effects.
    if (mode === 'resume') throw new Error('Resource confirmation evidence unavailable');
    resourceDb.exec('BEGIN IMMEDIATE');
    let id;
    try {
      const result = resourceDb.prepare('INSERT INTO effects(body) VALUES (?)').run(serialized);
      id = Number(result.lastInsertRowid);
      resourceDb.prepare('INSERT INTO receipts(operation, request, effect_id) VALUES (?, ?, ?)').run(operation, serialized, id);
      resourceDb.exec('COMMIT');
    } catch (error) {
      resourceDb.exec('ROLLBACK');
      throw error;
    }
    afterResourceCommit();
    return { id, text: request.text };
  },
};
const offer = new ResourceOffer({
  methods: {
    append(origin, request) {
      event('resource-method', { method: 'append' });
      return origin.append(request);
    },
    confirmOrAppend(origin, prepared) {
      event('resource-method', { method: 'confirmOrAppend' });
      return origin.confirmOrAppend(prepared.operation, prepared.request);
    },
  },
});
const resources = new Resources().register(new Resource(effects), offer);
const resourceBinding = resources.bind({ effects: offer.request() });
const reception = lifecycleReception();
const references = { child: { cardinality: 'one', position: 0 } };

const childBinding = {
  key: 'study.promise.child',
  version: 1,
  input: lifecycleCodec,
  output: lifecycleCodec,
  points: {
    ready: { state: lifecycleCodec, execute: () => assert.fail('Successful child must not resume its body') },
  },
};

function ref(parent, child) {
  const relation = parent.children.get(child);
  return { contextId: child.context.id, parentContextId: parent.context.id, parentRound: relation.round, order: relation.order, target: { position: relation.declarationPosition } };
}

function save(parent, child, point, state) {
  parent.checkpointWriter.save(point, state, { child: ref(parent, child) });
}

async function receive(parent, child, savedPrepared) {
  await child.run();
  const relation = parent.children.get(child);
  const output = await relation.accept(async (value) => {
    event('receiver-enter');
    // A local, writable draft is recreated on every activity entry. Only the
    // finalized request becomes stage material; editing state is not persisted.
    const draft = { text: value.text, scratch: `local:${process.pid}` };
    event('draft-created', { scratch: draft.scratch });
    const prepared = fixed.own({ operation: `${parent.context.id}:${child.context.id}:append`, request: { text: draft.text } });
    draft.text = 'discarded edit after the formal request';
    if (savedPrepared) assert.deepEqual(prepared, savedPrepared, 'Continuation must use the original formal request');
    else save(parent, child, 'receiving', { prepared });
    const access = resourceBinding.open();
    try {
      const endpoint = access.endpoints.effects;
      const request = mode === 'resume' && policy === 'changed-request' ? { ...prepared, request: { text: 'different' } } : prepared;
      const result = policy === 'plain' || policy === 'refuse' ? await endpoint.append(request.request) : await endpoint.confirmOrAppend(request);
      event('resource-delivered');
      return fixed.own(result);
    } finally {
      access.close();
      event('access-closed');
    }
  }, reception);
  save(parent, child, 'accepted', { output });
  return output;
}

function check(expected) {
  return (frame, _state, refs) => {
    assert.equal(frame.children.length, 1);
    assert.equal(frame.children[0].identity.contextId, refs.child.contextId);
    assert.equal(frame.children[0].state.reception.kind, expected);
  };
}

const parentBinding = {
  key: 'study.promise.parent',
  version: 1,
  input: lifecycleCodec,
  output: lifecycleCodec,
  children: [{ kind: 'node', binding: childBinding }],
  receptions: [reception],
  points: {
    receiving: {
      state: lifecycleCodec,
      references,
      check: check('receiving'),
      execute(_context, parent, state, refs) {
        event('parent-resume');
        // This is an explicit author recovery policy. The ordinary resource has
        // no evidence query, so no resource call is made on this branch.
        if (policy === 'refuse') throw new Error('Author refuses continuation without resource evidence');
        const child = parent.restoreChild(0, refs.child.contextId, () => assert.fail('Saved successful child is consumed without reconstruction'));
        return receive(parent, child, state.prepared);
      },
    },
    accepted: {
      state: lifecycleCodec,
      references,
      check: check('accepted'),
      execute(_context, _parent, state) {
        return state.output;
      },
    },
  },
};

try {
  if (mode === 'resume' && policy === 'missing-receipt') resourceDb.prepare('DELETE FROM receipts').run();
  const root =
    mode === 'resume'
      ? adapter.resume(rootId, { binding: parentBinding })
      : adapter.create({
          input: fixed.own({ text: 'one request' }),
          binding: parentBinding,
          async execute(context, parent) {
            event('parent-body');
            const child = adapter.create({
              parent,
              input: context.input,
              binding: childBinding,
              execute(childContext, invocation) {
                event('child-body');
                invocation.checkpointWriter.save('ready', { ready: true });
                return childContext.input;
              },
            });
            childId = child.context.id;
            return receive(parent, child);
          },
        });
  rootId = root.context.id;
  const result = await root.run();
  print(report({ result }));
} catch (error) {
  print(report({ error: { name: error.name, code: error.code, message: error.message } }));
  process.exitCode = 1;
} finally {
  adapter.close();
  resourceDb.close();
}
