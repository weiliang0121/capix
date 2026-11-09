import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableValue } from '@weiliang0121/capix-contracts';
import { Node, Group, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Transcript } from '@weiliang0121/capix-transcript';
import { Memories } from '@weiliang0121/capix-memory';
import { View } from '@weiliang0121/capix-view';
import { createConversationScene, createMaterialAnswer, createMaterialPreparation } from '@capix/conversation-service';
import { createConversationResources } from '@capix/conversation-service/assembly';

const clock = () => ({ at: performance.now(), cpu: process.cpuUsage() });
function elapsed(start) {
  const cpu = process.cpuUsage(start.cpu);
  return { elapsedMs: performance.now() - start.at, cpuMs: (cpu.user + cpu.system) / 1000 };
}
const reply = { formatVersion: 1, id: 'boundary-fixture', model: 'offline', output: [{ kind: 'text', text: 'offline answer' }], termination: { kind: 'completed', reason: 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } };

/** No persistence, recordings or live provider; every result still crosses production boundaries. */
export async function runBoundarySample(plan) {
  assert.ok(['runner', 'service'].includes(plan.profile));
  assert.ok(Number.isSafeInteger(plan.iterations) && plan.iterations > 0 && plan.iterations <= 100);
  const samples = [];
  if (plan.profile === 'runner') {
    assert.ok(['raw', 'trusted'].includes(plan.input));
    assert.ok(['text', 'records'].includes(plan.shape));
    assert.ok(Number.isSafeInteger(plan.size) && plan.size > 0 && plan.size <= (plan.shape === 'text' ? 2 * 1024 * 1024 : 100_000));
    const original = plan.shape === 'records' ? { items: Array.from({ length: plan.size }, (_, index) => ({ index, text: 'item' })) } : { text: 'x'.repeat(plan.size) };
    const preparing = clock();
    const input = plan.input === 'trusted' ? stableValue(original) : original;
    const preparation = elapsed(preparing);
    const building = clock();
    const node = new Node({ run: (work) => work.input });
    const group = new Group().add({ node });
    group.run = (work) => work.children.node.invoke(work.input);
    const scene = new Scene(group);
    const runner = new Runner(scene, new Resources()).build();
    const build = elapsed(building);
    for (let index = 0; index < plan.iterations; index++) {
      const started = clock();
      const result = await runner.run(input);
      samples.push(elapsed(started));
      assert.ok(Object.isFrozen(result));
      if (plan.input === 'trusted') assert.equal(result, input);
      else assert.notEqual(result, input);
      assert.equal(plan.shape === 'records' ? result.items.length : result.text.length, plan.size);
    }
    return { plan, status: 'completed', preparation, build, samples, callsPerRun: 3, checkpoints: 0, note: 'Raw versus trusted compares input fixation within the same current implementation; neither is a pre-migration baseline. Strings are already immutable and are not copied byte by byte.' };
  }
  assert.ok(Number.isSafeInteger(plan.historyBytes) && plan.historyBytes >= 32 && plan.historyBytes <= 2 * 1024 * 1024);
  for (let index = 0; index < plan.iterations; index++) {
    // New bounded history each time: accumulation across submissions is a separate dimension.
    const building = clock();
    const messages = Array.from({ length: 32 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: 'h'.repeat(Math.floor(plan.historyBytes / 32)) }));
    const transcript = new Transcript(messages);
    const memories = new Memories(transcript);
    const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: messages.map((_, key) => ({ source: 'messages', key })) });
    let calls = 0;
    let request;
    const provider = {
      complete(value, controls) {
        calls++;
        request = value;
        controls?.emit?.('offline ');
        controls?.emit?.('answer');
        return Promise.resolve(reply);
      },
    };
    const scene = createConversationScene(createMaterialAnswer(), createMaterialPreparation());
    const runner = new Runner(scene, createConversationResources({ transcript, memories, view }, provider)).build();
    let deltas = 0;
    const unsubscribe = runner.output.subscribe({
      receive: (event) => {
        if (event.kind === 'delta') deltas++;
      },
    });
    const build = elapsed(building);
    const started = clock();
    const result = await runner.run('Answer using the fixed history');
    const timing = elapsed(started);
    unsubscribe();
    assert.equal(result, 'offline answer');
    assert.equal(calls, 1);
    assert.equal(transcript.length, 34);
    assert.equal(deltas, 2);
    assert.ok(request.messages[1].content.includes(messages[0].content));
    samples.push({ ...timing, build, requestTextUnits: request.messages[1].content.length, modelCalls: calls, deltas });
  }
  return { plan, status: 'completed', samples, checkpoints: 0, note: 'Real service includes entity reads, schema validation, request JSON construction, resource operations, stable invocation boundaries and formal appends. These elapsed times are not exclusively stableValue cost. The provider is deterministic and performs no network I/O.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, value, destination] = process.argv.slice(2);
  if (mode === '--worker') {
    const plan = JSON.parse(await readFile(value, 'utf8'));
    await runBoundarySample({ profile: 'runner', shape: 'records', size: 16, input: 'raw', iterations: 4 });
    const result = await runBoundarySample(plan);
    await writeFile(destination, JSON.stringify({ ...result, processMaxRssKiB: process.resourceUsage().maxRSS, node: process.version }) + '\n', { flag: 'wx', mode: 0o600 });
  } else {
    if (mode !== '--out' || !value || destination !== undefined) throw new Error('Use --out NEW_DIRECTORY');
    const directory = resolve(value);
    await mkdir(directory);
    const plans = [];
    for (const input of ['raw', 'trusted']) for (const shape of ['text', 'records']) plans.push({ profile: 'runner', input, shape, size: shape === 'text' ? 2 * 1024 * 1024 : 100_000, iterations: 10 });
    for (const historyBytes of [128 * 1024, 2 * 1024 * 1024]) plans.push({ profile: 'service', historyBytes, iterations: 5 });
    const results = [];
    for (let repeat = 1; repeat <= 2; repeat++)
      for (const [index, plan] of (repeat === 1 ? plans : [...plans].reverse()).entries()) {
        const id = `${repeat}-${index}-${plan.profile}`;
        const planPath = join(directory, id + '.plan.json');
        const resultPath = join(directory, id + '.result.json');
        await writeFile(planPath, JSON.stringify(plan), { flag: 'wx' });
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', planPath, resultPath], { encoding: 'utf8', timeout: 60_000 });
        if (child.status !== 0) throw new Error('Boundary sample failed: ' + child.stderr);
        results.push({ repeat, ...JSON.parse(await readFile(resultPath, 'utf8')) });
        console.log(id);
      }
    await writeFile(join(directory, 'results.json'), JSON.stringify({ formatVersion: 1, results }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
}
