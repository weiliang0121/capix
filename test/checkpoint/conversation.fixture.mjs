import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { ObserverConversations, SqliteObserverStore } from '@capix/observer-service';

const [path, mode, boundary] = process.argv.slice(2);
const crash = (name) => {
  if (mode === 'start' && name === boundary) process.exit(74);
};
const persistence = SqliteObserverStore.open(path);
const save = persistence.checkpoints.save.bind(persistence.checkpoints);
persistence.checkpoints.save = (image, revision) => {
  const result = save(image, revision);
  if (image.contract.key === 'observer.request-model.answer' && image.point === 'feedbackAccepted') crash('feedback');
  if (image.contract.key === 'observer.conversation.task' && image.point === 'capabilityAccepted.answer') crash('accepted');
  return result;
};
const finish = persistence.checkpoints.finish.bind(persistence.checkpoints);
persistence.checkpoints.finish = (id, revision, delivery) => {
  const result = finish(id, revision, delivery);
  if (result.image.contract.key === 'observer.generate-answer.conversation' && delivery.status === 'succeeded') crash('delivery');
  if (result.image.contract.key === 'observer.conversation.task' && delivery.status === 'succeeded') crash('executionDelivery');
  return result;
};
const commit = persistence.transcript.commit.bind(persistence.transcript);
persistence.transcript.commit = (change) => {
  const result = commit(change);
  if (change.kind === 'append' && change.fixed) crash('entity');
  return result;
};
let releaseIndependent;
const independent = new Promise((resolve) => {
  releaseIndependent = resolve;
});
const provider = {
  async invoke(request, purpose) {
    if (request.model === 'independent') return independent;
    appendFileSync(path + '.calls', JSON.stringify({ purpose, model: request.model }) + '\n');
    if (purpose === 'memory') crash('memory');
    if (purpose === 'answer') crash('pending');
    const output = purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? { kind: 'answer', content: '真实对话恢复的回答。' } : { memories: boundary === 'executionDelivery' ? [{ action: 'create', memoryId: null, change: '保存已成立的交流依据', sourceIndexes: [0, 1], result: { topic: '恢复验证', content: '用户验证新对话，助手已回应。', sourceIndexes: [0, 1] } }] : [] };
    return { id: 'fixture', model: request.model, content: JSON.stringify(output), finishReason: 'stop', usage: null };
  },
};
const conversations = new ObserverConversations(provider, [], { persistence });
const conversationId = mode === 'start' ? conversations.create().id : readFileSync(path + '.conversation', 'utf8');
if (mode === 'start') writeFileSync(path + '.conversation', conversationId);
const environment = conversations.open(conversationId);
let result;
let error;
let activeAfterRecovery;
let concurrentRecovery;
let independentRef;
try {
  if (mode === 'start') result = await environment.driver.run(environment.scene, { messages: [{ role: 'user', content: '你好，验证新对话。' }] }, { settings: { model: 'fixed-model', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 } });
  else {
    const run = persistence.checkpointRuns.list(conversationId)[0];
    if (mode === 'changed') environment.transcript.append({ role: 'user', content: '后续新问题。' });
    if (mode === 'restore-active') independentRef = environment.interactions.start({ model: 'independent', messages: [], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 1, stream: false }, 'answer', { timeoutMs: 1000 });
    const recovering = conversations.recover(conversationId, run.rootContextId);
    if (mode === 'restore-active') {
      try {
        await conversations.recover(conversationId, run.rootContextId);
      } catch (failure) {
        concurrentRecovery = failure.code;
      }
    }
    result = await recovering;
    if (mode === 'restore-active') activeAfterRecovery = environment.interactions.active;
  }
} catch (failure) {
  error = { code: failure.code, message: failure.message };
}
if (independentRef) {
  releaseIndependent({ id: 'independent', model: 'independent', content: 'independent feedback', finishReason: 'stop', usage: null });
  await environment.interactions.settled();
}
const run = persistence.checkpointRuns.list(conversationId)[0];
const calls = existsSync(path + '.calls')
  ? readFileSync(path + '.calls', 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
process.stdout.write(JSON.stringify({ result, error, activeAfterRecovery, concurrentRecovery, independentFeedback: independentRef && persistence.interactions.read(independentRef.id)?.feedback, run, calls, transcript: environment.transcript.exportState(), memories: environment.memories.exportState(), root: run && persistence.checkpoints.read(run.rootContextId), execution: run && persistence.checkpoints.read(run.executionContextId) }));
conversations.close();
