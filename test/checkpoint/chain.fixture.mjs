import { DatabaseSync } from 'node:sqlite';
import { RuntimeDefinition, ExecutionDefinition, OperationDefinition, AttemptDefinition, TranscriptResource, Transcript, Memories, assembleRuntime } from '@capix/server-runtime';
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
const point = (execute, requires = {}, uses = []) => ({ state: codec, resume: { requires, uses, execute } });
const cp = (key, points) => ({ key, version: 1, input: codec, output: codec, points });
class Model extends AttemptDefinition {
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
class Request extends OperationDefinition {
  name = 'request';
  label = 'request';
  source = 'test';
  children = [model];
  checkpoint = cp('chain.request', { feedback: point((_context, _invocation, _children, state) => state.output) });
  run = {
    requires: {},
    execute: async (_context, invocation, children) => {
      const request = children.get(model).create(invocation, { prompt: 'question' });
      await request.run();
      const output = await children.accept(request, (value) => value);
      invocation.checkpoint.save('feedback', { output });
      crash('feedback');
      return output;
    },
  };
}
const request = new Request();
const requires = { messages: TranscriptResource.append.request() };
async function consume(context, invocation, children, child, allowCrash) {
  await child.run();
  if (allowCrash) crash('delivery');
  const output = await children.accept(child, (value) => {
    invocation.checkpoint.save('reception', { childId: child.context.id });
    const receipt = context.resources.values.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: value.content }] });
    if (allowCrash) crash('entity');
    return { receipt, answer: value.content };
  });
  invocation.checkpoint.save('accepted', { output });
  if (allowCrash) crash('accepted');
  return output;
}
const resume = (context, invocation, children, state) => consume(context, invocation, children, children.get(request).resume(invocation, state.childId), false);
class Conversation extends ExecutionDefinition {
  children = [request];
  checkpoint = cp('chain.execution', { waiting: point(resume, requires, [request]), reception: point(resume, requires, [request]), accepted: point((_context, _invocation, _children, state) => state.output) });
  run = {
    requires,
    execute: async (context, invocation, children) => {
      const child = children.get(request).create(invocation, { prompt: 'question' }, { key: 'answer' });
      invocation.checkpoint.save('waiting', { childId: child.context.id });
      return consume(context, invocation, children, child, true);
    },
  };
}
const conversation = new Conversation();
class Root extends RuntimeDefinition {
  children = [conversation];
  checkpoint = cp('chain.runtime', {
    waiting: point(
      async (_context, invocation, children, state) => {
        const child = children.get(conversation).resume(invocation, state.childId);
        await child.run();
        return children.accept(child, (output) => output);
      },
      {},
      [conversation],
    ),
  });
  run = {
    requires: {},
    execute: async (context, invocation, children) => {
      put('rootId', context.id);
      const child = children.get(conversation).create(invocation, { question: 'question' });
      invocation.checkpoint.save('waiting', { childId: child.context.id });
      await child.run();
      return children.accept(child, (output) => output);
    },
  };
}
const facts = [];
const store = new SqliteCheckpointStore(database);
const runtime = assembleRuntime(new Root(), { checkpoints: { store, observation: { observe: (fact) => facts.push(fact) } }, providers: [TranscriptResource.append.provide(() => transcript)], source: { runtime: () => null, entry: () => null, capture: () => null } });
const output = mode === 'start' ? await runtime.run({ question: 'question' }, {}) : await runtime.resume(saved('rootId'), {});
process.stdout.write(JSON.stringify({ output, messages: transcript.exportState().messages, appends: transcript.exportState().appends, calls: Number(saved('modelCalls')), terminal: store.read(saved('rootId')).delivery, restoredChildren: facts.filter((fact) => fact.kind === 'child-restored').map((fact) => ({ mode: fact.mode, contextId: fact.child.identity.contextId, state: fact.child.state.kind })), recovery: facts.filter((fact) => fact.kind === 'installed').map((fact) => ({ activityId: fact.activityId, contextId: fact.contextId, children: fact.frame.children.length })) }));
content.close();
database.close();
