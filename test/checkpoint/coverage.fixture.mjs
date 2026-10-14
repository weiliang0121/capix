import { appendFileSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ObserverConversations, SqliteObserverStore, WorkspaceFiles } from '@capix/observer-service/assembly';

const [path, mode, boundary, scenario = 'file'] = process.argv.slice(2);
const workspace = join(dirname(path), 'files');
mkdirSync(workspace, { recursive: true });
if (mode === 'start') writeFileSync(join(workspace, 'notes.md'), '原始资料');
const crash = (name) => {
  if (mode === 'start' && name === boundary) process.exit(75);
};
const persistence = SqliteObserverStore.open(path);
const save = persistence.checkpoints.save.bind(persistence.checkpoints);
persistence.checkpoints.save = (image, revision) => {
  const result = save(image, revision);
  const key = image.contract.key;
  if (key === 'observer.select-history' && image.point === 'result') crash('selectionResult');
  if (key === 'observer.request-model.understanding' && image.point === 'feedbackAccepted') crash('understandingFeedback');
  if (key.startsWith('observer.default-decision') && image.point === 'result') crash('decisionResult');
  if (key === 'observer.file-preflight' && image.point === 'result') crash('preflightResult');
  if (key === 'observer.read-text' && image.point === 'result') crash('readResult');
  if (key === 'observer.request-model.answer' && image.point === 'feedbackAccepted') {
    const answers = readCalls().filter((call) => call.purpose === 'answer').length;
    if (scenario !== 'regeneration' || answers === 2) crash('answerFeedback');
  }
  if (key === 'observer.request-model.memory' && image.point === 'feedbackAccepted') crash('memoryFeedback');
  if (key === 'observer.apply-memory' && image.point === 'prepared') crash('memoryPrepared');
  if (key === 'observer.create-text' && image.point === 'prepared') crash('filePrepared');
  if (key === 'observer.conversation.execution') {
    if (image.point === 'selectionAccepted') crash('selectionAccepted');
    if (image.point === 'decisionAccepted') crash('decisionAccepted');
    if (image.point === 'answerAccepted') crash('answerAccepted');
    if (image.point === 'capabilityAccepted' && image.state.progress.file && !image.state.progress.answer) crash('preflightAccepted');
    if (image.point === 'capabilityAccepted' && image.state.progress.saved) crash('fileAccepted');
    if (image.point === 'completed') crash('completed');
  }
  return result;
};
const fileCreate = persistence.fileCreations.create.bind(persistence.fileCreations);
persistence.fileCreations.create = (state) => {
  const result = fileCreate(state);
  crash('filePending');
  return result;
};
const fileComplete = persistence.fileCreations.complete.bind(persistence.fileCreations);
persistence.fileCreations.complete = (state) => {
  const result = fileComplete(state);
  crash('fileCommitted');
  return result;
};
const memoryCommit = persistence.memories.commit.bind(persistence.memories);
persistence.memories.commit = (change) => {
  const result = memoryCommit(change);
  if (change.fixed) crash('memoryCommitted');
  return result;
};
const transcriptCommit = persistence.transcript.commit.bind(persistence.transcript);
persistence.transcript.commit = (change) => {
  const result = transcriptCommit(change);
  if (change.fixed) crash('answerCommitted');
  return result;
};
const interactionCommit = persistence.interactions.commit.bind(persistence.interactions);
persistence.interactions.commit = (change) => {
  const result = interactionCommit(change);
  const saved = persistence.interactions.read(change.state.id);
  if (saved?.request.purpose === 'answer' && saved.feedback) crash('interactionFeedback');
  return result;
};
function readCalls() {
  return existsSync(path + '.calls')
    ? readFileSync(path + '.calls', 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
const provider = {
  async invoke(request, purpose) {
    appendFileSync(path + '.calls', JSON.stringify({ purpose, content: request.messages.at(-1).content }) + '\n');
    const count = readCalls().filter((call) => call.purpose === 'answer').length;
    const output = purpose === 'selection' ? { historyIndexes: [] } : purpose === 'understanding' ? (scenario === 'clarify' ? { kind: 'clarify', question: '请指定来源文件。' } : { kind: 'file', task: { sourcePath: 'notes.md', output: { path: 'result.md' } }, instruction: '整理来源文件并保存。' }) : purpose === 'memory' ? { memories: [{ action: 'create', memoryId: null, change: '保存已接纳结果', sourceIndexes: [0, 1], result: { topic: '文件整理', content: '本次处理已经完成。', sourceIndexes: [0, 1] } }] } : { kind: 'answer', content: '整理后的正文。' };
    return { id: 'mock', model: request.model, content: scenario === 'regeneration' && purpose === 'answer' && count === 1 ? '{broken' : JSON.stringify(output), finishReason: 'stop', usage: null };
  },
};
const conversations = new ObserverConversations(provider, [], { persistence, ...(scenario !== 'regeneration' ? { files: new WorkspaceFiles({ root: workspace, persistence: persistence.fileCreations }) } : {}) });
const conversationId = mode === 'start' ? conversations.create().id : readFileSync(path + '.conversation', 'utf8');
if (mode === 'start') writeFileSync(path + '.conversation', conversationId);
const environment = conversations.open(conversationId);
let result;
let error;
try {
  if (mode === 'start') result = await environment.runtime.run({ messages: [{ role: 'user', content: '整理文件并保存。' }] }, { settings: { model: 'fixed', contextBudget: 32768, maxOutputTokens: 1024, timeoutMs: 1000 } });
  else {
    if (mode === 'changedFile') writeFileSync(join(workspace, 'notes.md'), '后来改动');
    const run = persistence.checkpointRuns.list(conversationId)[0];
    result = await conversations.recover(conversationId, run.rootContextId);
  }
} catch (failure) {
  error = { message: failure.message, code: failure.code, stack: failure.stack };
}
const run = persistence.checkpointRuns.list(conversationId)[0];
process.stdout.write(JSON.stringify({ result, error, calls: readCalls().map((call) => ({ purpose: call.purpose })), transcript: environment.transcript.exportState(), memories: environment.memories.exportState(), file: existsSync(join(workspace, 'result.md')) ? readFileSync(join(workspace, 'result.md'), 'utf8') : null, rootContextId: run?.rootContextId, root: run && persistence.checkpoints.read(run.rootContextId)?.delivery, observation: run && environment.checkpointObservation?.query(run.rootContextId).activities.map((activity) => ({ rootContextId: activity.rootContextId, contextId: activity.contextId, recovering: activity.recovering, last: activity.last })) }));
conversations.close();
