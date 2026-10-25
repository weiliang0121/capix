import { readOutput } from '@capix/protocol';
// Optional real-provider check. Uses the product execution unchanged; not part of the offline test suite.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DeepSeekProvider, initializeObserver, acceptConversationInput, observeExecution } from '@capix/observer-service';

const directory = resolve(process.argv[2] || 'traces/memoryLoop');
await mkdir(directory);
const environment = initializeObserver(new DeepSeekProvider(process.env.DEEPSEEK_API_KEY?.trim() || ''));
const settings = { model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 90000 };
const scenario = process.argv[3] ? JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')) : { messages: ['帮我记一下：周六聚餐总预算200元，我自己买办公键盘的预算300元。两件事分开，先不用推荐。', '聚餐改成150，键盘不变。', '这两件事现在各留多少预算？'] };
if (scenario.contextBudget) settings.contextBudget = scenario.contextBudget;
const messages = scenario.messages;
assert(Array.isArray(messages) && messages.length >= 2 && messages.every((message) => typeof message === 'string' && message.trim()));
await writeFile(resolve(directory, 'scenario.json'), JSON.stringify({ ...scenario, settings }, null, 2));
const results = [];
for (const content of messages) {
  if (scenario.budgets?.[results.length]) settings.contextBudget = scenario.budgets[results.length];
  const previousMemories = environment.memories.values().map((memory) => memory.toJSON());
  const input = { role: 'user', content };
  const facts = await observeExecution(environment.runner, environment.records.installation, { messages: [input] }, { settings, transcript: environment.transcript });
  const currentMemories = environment.memories.values().map((memory) => memory.toJSON());
  const segments = environment.transcript.segments().map(({ start, end }) => ({ start, end }));
  results.push({ previousMemories, facts, currentMemories, segments });
  await writeFile(resolve(directory, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ round: results.length, status: facts.execution.status, activeStart: environment.transcript.activeStart, memoryCountBefore: previousMemories.length, memoryCountAfter: currentMemories.length, output: readOutput(facts.execution.value), error: facts.execution.value.error?.code }));
  assert.equal(facts.execution.status, 'succeeded', 'Keep the failed record and stop; no repair or retry');
  const operation = (name) => facts.operations.find((item) => item.operation === name);
  const requestInput = (name) => JSON.parse(readOutput(facts.attempts.find((item) => item.operationId === operation(name).id && item.name === 'prepareModelRequest').value).messages[1].content);
  assert.deepEqual(operation('selection').value.input, { message: input, memories: previousMemories });
  assert.deepEqual(requestInput('selection').memories, previousMemories);
  assert.deepEqual(requestInput('memory').memories, previousMemories);
  assert.deepEqual(requestInput('selection').message, input);
  const { start } = facts.resources.find((fact) => fact.parentId === facts.execution.id && fact.access === 'transcript.fixedRange' && fact.phase === 'available').value;
  assert(requestInput('selection').history.every((item) => item.index >= start));
  assert(requestInput('memory').messages.every((item) => item.index >= start));
  assert.deepEqual(requestInput('answer').memories, previousMemories);
  assert.deepEqual(
    requestInput('answer').history.map((item) => item.index),
    [...readOutput(operation('selection').value).historyIndexes].sort((a, b) => a - b),
  );
  assert.equal(environment.transcript.length, results.length * 2);
}
if (scenario.requireSegment) assert(environment.transcript.segments().length > 1, 'The scenario must exercise an actual capacity-triggered segment switch');
assert(results[1].previousMemories.length > 0, 'This real run must actually carry extracted memory into the next selection');
console.log(`Verified the product memory loop; records: ${directory}/results.json`);
