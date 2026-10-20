import { installCallable } from '../fixtures/driver.mjs';
import { DatabaseSync } from 'node:sqlite';
import { Scene, Group, Node, TranscriptResource, Transcript, Memories, childReference } from '@capix/server-runtime';
import { SqliteCheckpointStore, SqliteObserverStore } from '@capix/observer-service';

const [path, mode, boundary] = process.argv.slice(2);
const content = SqliteObserverStore.open(path);
if (!content.loadContent()) {
  const transcript = new Transcript([{ role: 'user', content: 'question' }]);
  content.initialize({ transcript: transcript.exportState(), memories: new Memories(transcript).exportState() });
}
const transcript = Transcript.restore(content.loadContent().transcript, { persistence: content.transcript });
const database = new DatabaseSync(path + '.checkpoints');
database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
database.exec('CREATE TABLE IF NOT EXISTS test_driver (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const saved = (key) => database.prepare('SELECT value FROM test_driver WHERE key=?').get(key)?.value;
const put = (key, value) => database.prepare('INSERT INTO test_driver(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
const crash = (name) => {
  if (mode === 'start' && boundary === name) process.exit(74);
};
const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
const point = (execute, requires = {}, uses = [], references = {}) => ({ state: codec, references, resume: { requires, uses, execute } });
const cp = (key, points) => ({ key, version: 1, input: codec, output: codec, points: Object.entries(points).map(([name, value]) => ({ name, ...value })) });
class Model extends Node {
  name = 'model';
  label = 'model';
  source = 'test';
  run = {
    requires: {},
    execute: () => {
      put('modelCalls', Number(saved('modelCalls') ?? 0) + 1);
      return { content: 'fixed answer' };
    },
  };
}
const model = new Model();
class Request extends Group {
  name = 'request';
  label = 'request';
  source = 'test';
  members = [model];
  checkpoint = cp('chain.request', { feedback: point((_work, state) => state.output) });
  run = {
    requires: {},
    execute: async (work) => {
      const request = work.children.create(model, { prompt: 'question' });
      await request.run();
      const output = await request.accept((value) => value);
      work.checkpoint.save(this.checkpoint.points[0], { output }, {});
      crash('feedback');
      return output;
    },
  };
}
const request = new Request();
const requires = { messages: TranscriptResource.append.request() };
async function consume(work, child, allowCrash, points) {
  await child.run();
  if (allowCrash) crash('delivery');
  const output = await child.accept((value) => {
    work.checkpoint.save(
      points.find((point) => point.name === 'reception'),
      null,
      { child: child.ref },
    );
    const receipt = work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: value.content }] });
    if (allowCrash) crash('entity');
    return { receipt, answer: value.content };
  });
  work.checkpoint.save(
    points.find((point) => point.name === 'accepted'),
    { output },
    {},
  );
  if (allowCrash) crash('accepted');
  return output;
}
const resume = (work, _state, saved) => consume(work, work.children.resume(saved.child), false, executionPoints);
const executionPoints = cp('chain.execution', { waiting: point(resume, requires, [request], { child: childReference(request) }), reception: point(resume, requires, [request], { child: childReference(request) }), accepted: point((_work, state) => state.output) }).points;
class Conversation extends Group {
  members = [request];
  checkpoint = { key: 'chain.execution', version: 1, input: codec, output: codec, points: executionPoints };
  run = {
    requires,
    execute: async (work) => {
      const child = work.children.create(request, { prompt: 'question' }, { key: 'answer' });
      work.checkpoint.save(this.checkpoint.points[0], null, { child: child.ref });
      return consume(work, child, true, executionPoints);
    },
  };
}
const conversation = new Conversation();
class Root extends Scene {
  members = [conversation];
  checkpoint = cp('chain.runtime', {
    waiting: point(
      async (work, _state, saved) => {
        const child = work.children.resume(saved.child);
        await child.run();
        return child.accept((output) => output);
      },
      {},
      [conversation],
      { child: childReference(conversation) },
    ),
  });
  run = {
    requires: {},
    execute: async (work) => {
      const child = work.children.create(conversation, { question: 'question' });
      work.checkpoint.save(this.checkpoint.points[0], null, { child: child.ref });
      await child.run();
      return child.accept((output) => output);
    },
  };
}
const facts = [];
const store = new SqliteCheckpointStore(database);
const save = store.save.bind(store);
store.save = (image, revision) => {
  if (image.frame.owner.kind === 'scene') put('rootId', image.frame.owner.contextId);
  return save(image, revision);
};
const runtime = installCallable(new Root(), { checkpoints: { store, observation: { observe: (fact) => facts.push(fact) } }, providers: [TranscriptResource.append.provide(() => transcript)], source: { capture: () => null } });
const output = mode === 'start' ? await runtime.run({ question: 'question' }, {}) : await runtime.resume(saved('rootId'), {});
process.stdout.write(JSON.stringify({ output, messages: transcript.exportState().messages, appends: transcript.exportState().appends, calls: Number(saved('modelCalls')), terminal: store.read(saved('rootId')).delivery, restoredChildren: facts.filter((fact) => fact.kind === 'child-restored').map((fact) => ({ mode: fact.mode, contextId: fact.child.identity.contextId, state: fact.child.state.kind })), recovery: facts.filter((fact) => fact.kind === 'installed').map((fact) => ({ activityId: fact.activityId, contextId: fact.contextId, children: fact.frame.children.length })) }));
content.close();
database.close();
