import { DatabaseSync } from 'node:sqlite';
import { writeSync } from 'node:fs';
import { z } from 'zod';
import { Node, Scene, checkpointPoint, childReference } from '@weiliang0121/capix-structure';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Interactions } from '@weiliang0121/capix-interaction';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { CompletionInteraction } from '@capix/conversation-service';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { createToolLoop, registerToolLoopResources, tool, toolLoopInputCodec } from '@capix/conversation-service/tools';
import { requireModelReply } from '@weiliang0121/capix-model-provider';

// Test-only author scheduling: omit calls to Work.checkpoint before they enter
// the mechanism. Kept writes use the actual store and real CAS receipts.
const [mode, path, policy = 'baseline', cut = 'none'] = process.argv.slice(2);
const allowed = new Set(['dispatch', 'success', 'handled', 'final', 'rejected']);
const removed = new Set(policy === 'baseline' ? [] : policy === 'batch' ? ['dispatch', 'success', 'handled', 'rejected'] : policy.split(','));
if (!['run', 'crash', 'resume', 'resume-crash', 'inspect'].includes(mode) || [...removed].some((item) => !allowed.has(item))) throw new Error('Invalid matrix fixture arguments');
const cuts = new Set(['none', 'dispatch-success', 'effect-after', 'child-success', 'feedback-success', 'accepted-success', 'dispatch-failure', 'child-failure', 'feedback-failure', 'handled-failure', 'rejected-feedback', 'rejected-checkpoint', 'final-feedback', 'final-processing', 'completed']);
if (!cuts.has(cut)) throw new Error('Unknown crash cut');
const store = ConversationStore.open(path);
const ledger = new DatabaseSync(`${path}.facts`);
ledger.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS effects (context_id TEXT PRIMARY KEY, body TEXT NOT NULL);');
function event(kind, body = {}) {
  ledger.prepare('INSERT INTO events (kind,body) VALUES (?,?)').run(kind, JSON.stringify(body));
}
function events() {
  return ledger
    .prepare('SELECT seq,kind,body FROM events ORDER BY seq')
    .all()
    .map((row) => ({ seq: row.seq, kind: row.kind, ...JSON.parse(row.body) }));
}
function roots() {
  return store.checkpoints.listRoots().filter((head) => head.image.contract.key === 'test.matrix.scene');
}
function report(extra = {}) {
  const history = events();
  const root = roots().at(-1);
  const loopId = root?.image.frame.children[0]?.identity.contextId;
  const loopHead = loopId ? store.checkpoints.read(loopId) : undefined;
  const archive = store.exchanges.list().items[0];
  const saved = archive ? store.exchanges.load(archive.id).state : undefined;
  return {
    mode,
    policy,
    cut,
    ...extra,
    events: history,
    requests: history.filter((item) => item.kind === 'request').map((item) => item.name),
    mappings: history.filter((item) => item.kind === 'mapping').map((item) => item.name),
    effects: ledger
      .prepare('SELECT context_id,body FROM effects ORDER BY rowid')
      .all()
      .map((row) => ({ contextId: row.context_id, ...JSON.parse(row.body) })),
    exchanges: saved?.entries ?? [],
    roots: roots().map((head) => ({ id: head.image.frame.owner.contextId, status: head.delivery?.status ?? 'pending' })),
    loop: loopHead ? { point: loopHead.image.point, state: loopHead.image.state, children: loopHead.image.frame.children, status: loopHead.delivery?.status ?? 'pending' } : null,
    saveCount: history.filter((item) => item.kind === 'save').length,
    skippedCount: history.filter((item) => item.kind === 'skip').length,
  };
}
function print(value) {
  writeSync(1, `${JSON.stringify(value)}\n`);
}
function hit(name) {
  if (mode !== 'inspect') event('boundary', { name });
  if ((mode === 'crash' || mode === 'resume-crash') && cut === name) {
    print(report({ halted: name }));
    process.exit(73); // Deliberately no close, finish, catch or normal unwinding.
  }
}
const content = loadConversationContent(store);
if (!content.transcript.length) content.transcript.append({ role: 'user', content: 'Fixed fixture input.' });
const exchangePersistence = {
  commit(change) {
    store.exchanges.commit(change);
    event('exchange', { id: change.entry.id, revision: change.entry.revision, operation: change.entry.operation, receptions: change.entry.receptions });
    const added = change.entry.feedback.at(-1)?.toolCallId;
    if (change.entry.feedback.length > (change.previous?.feedback.length ?? 0)) {
      if (added === 'effect-1') hit('feedback-success');
      if (added === 'failure-1') hit('feedback-failure');
      if (added === 'rejected-1') hit('rejected-feedback');
    }
  },
};
const archive = store.exchanges.list().items[0];
const exchanges = archive ? ModelExchanges.restore(store.exchanges.load(archive.id).state, { persistence: exchangePersistence }) : new ModelExchanges({ persistence: exchangePersistence });
if (!archive) store.exchanges.initialize(exchanges.snapshot(), { source: { transcriptId: content.transcript.id, index: 0 }, scope: 'matrix-scope', policy: { fixture: 'matrix-v1' }, limits: { entries: 100, bytes: 64 * 1024 * 1024 } });
const textCodec = { encode: (value) => z.string().parse(value), decode: (value) => z.string().parse(value) };
const nullCodec = { encode: (value) => z.null().parse(value), decode: (value) => z.null().parse(value) };
const input = z.strictObject({ key: z.string() });
const inputCodec = { encode: (value) => input.parse(value), decode: (value) => input.parse(value) };
class ExpectedFailure extends Error {}
const effects = new ResourceOffer({
  expose(database, activity) {
    const contextId = activity.origin.contextId;
    return {
      perform(key) {
        return activity.runSync('perform', {}, () => {
          // Fixed by the actual invocation identity. A new child identity performs
          // another effect even for the same business key, exposing unsafe replay.
          const row = database.prepare('SELECT body FROM effects WHERE context_id=?').get(contextId);
          if (row) return JSON.parse(row.body).result;
          const result = `effect:${key}`;
          database.prepare('INSERT INTO effects VALUES (?,?)').run(contextId, JSON.stringify({ key, result }));
          event('effect', { contextId, key });
          hit('effect-after');
          return result;
        });
      },
      confirm(key) {
        return activity.runSync('confirm', {}, () => {
          const row = database.prepare('SELECT body FROM effects WHERE context_id=?').get(contextId);
          if (!row || JSON.parse(row.body).key !== key) throw new Error('Effect is unknown; it cannot be replayed');
          event('effect-confirmed', { contextId, key });
          return JSON.parse(row.body).result;
        });
      },
    };
  },
});
const deps = { effects: effects.request() };
const effectPrepared = checkpointPoint()({ name: 'prepared', state: nullCodec, references: {}, resume: { deps, run: (work) => work.resources.effects.confirm(work.input.key) } });
const effectDone = checkpointPoint()({ name: 'done', state: textCodec, references: {}, resume: { run: (_work, value) => value } });
const effectNode = new Node({
  deps,
  checkpoint: { key: 'test.matrix.effect', version: 1, input: inputCodec, output: textCodec, points: [effectPrepared, effectDone] },
  run(work) {
    work.checkpoint({ point: effectPrepared, state: null, refs: {} });
    const result = work.resources.effects.perform(work.input.key);
    work.checkpoint({ point: effectDone, state: result, refs: {} });
    return result;
  },
});
const failurePrepared = checkpointPoint()({
  name: 'prepared',
  state: nullCodec,
  references: {},
  resume: {
    run() {
      throw new Error('Failed tool cannot be restarted');
    },
  },
});
const failureNode = new Node({
  checkpoint: { key: 'test.matrix.failure', version: 1, input: inputCodec, output: textCodec, points: [failurePrepared] },
  run(work) {
    work.checkpoint({ point: failurePrepared, state: null, refs: {} });
    event('failure-attempt');
    throw new ExpectedFailure('expected tool rejection');
  },
});
const mapped = (name, status, text) => {
  event('mapping', { name }); // Diagnostic counter only; mapped business value is pure.
  return { status, content: [{ kind: 'text', text }] };
};
const loop = createToolLoop({
  checkpoint: true,
  policyVersion: 'matrix-v1',
  maxModelCalls: 3,
  waitMs: 1000,
  tools: {
    effect: tool(effectNode, { description: 'Perform one fixed effect.', input, result: { succeeded: (value) => mapped('success', 'ok', value) } }),
    failure: tool(failureNode, {
      description: 'Return an expected business rejection.',
      input,
      result: {
        succeeded: (value) => mapped('unexpected-success', 'ok', value),
        failed: (failure) => {
          if (!(failure instanceof ExpectedFailure)) throw failure;
          return mapped('failure', 'error', failure.message);
        },
      },
    }),
  },
});
function filtered(work) {
  return {
    ...work,
    checkpoint: Object.assign(
      (options) => {
        const state = options.state;
        let omission;
        let boundary;
        if (options.point.name === 'tools') {
          if (state.active) {
            omission = 'dispatch';
            boundary = state.active.name === 'effect' ? 'dispatch-success' : 'dispatch-failure';
          } else if (state.cursor === 1) {
            omission = 'success';
            boundary = 'accepted-success';
          } else if (state.cursor === 2) {
            omission = 'handled';
            boundary = 'handled-failure';
          } else if (state.cursor === 3) {
            omission = 'rejected';
            boundary = 'rejected-checkpoint';
          } else if (options.refs.models.length === 2) {
            omission = 'final';
            boundary = 'final-processing';
          }
        } else if (options.point.name === 'completed') boundary = 'completed';
        if (omission && removed.has(omission)) event('skip', { point: options.point.name, omission, boundary });
        else work.checkpoint(options);
        if (boundary) hit(boundary);
      },
      { select: work.checkpoint.select },
    ),
  };
}
const originalRun = loop.run;
loop.run = (work) => originalRun.call(loop, filtered(work));
for (const point of loop.checkpoint.points) {
  const run = point.resume.run;
  point.resume.run = (work, state, refs) => run(filtered(work), state, refs);
}
let release;
const interactions = new Interactions().register(CompletionInteraction, {
  persistence: {
    create: (value) => store.interactions.create(value),
    read: (id) => store.interactions.read(id),
    commit(change) {
      store.interactions.commit(change);
      if (change.state.feedback && change.state.request.exchanges?.length) hit('final-feedback');
    },
  },
  send(request) {
    const final = !!request.exchanges?.length;
    event('request', { name: final ? 'final' : 'tools' });
    const call = (id, name) => ({ kind: 'tool-call', id, name, arguments: { encoding: 'json-text', text: JSON.stringify({ key: 'one' }) } });
    const value = requireModelReply({ formatVersion: 1, id: final ? 'final-reply' : 'tools-reply', model: 'fixture', output: final ? [{ kind: 'text', text: 'matrix complete' }] : [call('effect-1', 'effect'), call('failure-1', 'failure'), call('rejected-1', 'unknown')], termination: { kind: 'completed', reason: final ? 'stop' : 'tool_calls' }, usage: null, native: { format: 'chat-completions', version: 1 } });
    return new Promise((resolve) => {
      release = () => resolve(value);
    });
  },
});
const resources = new Resources().register(new Resource(ledger), effects);
registerToolLoopResources(resources, loop, exchanges, interactions.bind(CompletionInteraction), { read: (id) => store.interactions.read(id) });
const waiting = checkpointPoint()({ name: 'waiting', state: nullCodec, references: { loop: childReference(loop) }, resume: { uses: [loop], run: (work, _state, refs) => work.children.resume(refs.loop).invoke() } });
const scene = new Scene({ checkpoint: { key: 'test.matrix.scene', version: 1, input: toolLoopInputCodec, output: textCodec, points: [waiting] } }).add({ loop });
scene.run = (work) => {
  const child = work.children.create(loop, work.input);
  work.checkpoint({ point: waiting, state: null, refs: { loop: child.ref } });
  return child.invoke();
};
const checkpoints = {
  read: (id) => store.checkpoints.read(id),
  save(image, revision) {
    const receipt = store.checkpoints.save(image, revision);
    event('save', { contextId: image.frame.owner.contextId, contract: image.contract.key, point: image.point });
    if (image.contract.key === 'conversation.tools.completion' && image.point === 'established') {
      const resolve = release;
      release = undefined;
      resolve?.();
    }
    return receipt;
  },
  finish(id, revision, delivery) {
    const receipt = store.checkpoints.finish(id, revision, delivery);
    const key = store.checkpoints.read(id).image.contract.key;
    event('finish', { contextId: id, contract: key, status: delivery.status });
    if (key === 'test.matrix.effect') hit('child-success');
    if (key === 'test.matrix.failure') hit('child-failure');
    return receipt;
  },
};
const runner = new Runner(scene, resources, interactions, { checkpoints: { store: checkpoints } }).build();
try {
  const root = roots().at(-1);
  const result = mode === 'inspect' ? undefined : mode === 'resume' || mode === 'resume-crash' ? await runner.resume(root.image.frame.owner.contextId) : await runner.run(loop.input({ messages: [{ role: 'user', content: 'Fixed fixture input.' }] }, 'matrix-scope', exchanges.id));
  await interactions.settled();
  print(report({ result }));
} catch (error) {
  const causes = [];
  let current = error;
  while (current && causes.length < 8) {
    causes.push({ name: current.name, code: current.code, message: current.message });
    current = current.cause;
  }
  print(report({ error: { name: error.name, code: error.code, message: error.message, causes } }));
  process.exitCode = 1;
} finally {
  await interactions.settled();
  interactions.close();
  store.close();
  ledger.close();
}
