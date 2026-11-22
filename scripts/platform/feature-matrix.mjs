// Run in a production installation. Hosts requiring a UUID provider must install it before importing this module.
import { FactType } from '@weiliang0121/capix-changes';
import { MemoryCheckpointStore, cloneCheckpointHead, cloneCheckpointValue, createCheckpointValueBlock } from '@weiliang0121/capix-checkpoint';
import { decodeCheckpointData, encodeCheckpointData } from '@weiliang0121/capix-checkpoint/storage';
import { stableValue } from '@weiliang0121/capix-contracts';
import { RuntimeErrorHelper } from '@weiliang0121/capix-diagnostics';
import { Interactions } from '@weiliang0121/capix-interaction';
import { InvocationChildren, InvocationContext, invocationResourceFailures } from '@weiliang0121/capix-invocation';
import { MessageUsage } from '@weiliang0121/capix-measurement';
import { Memories } from '@weiliang0121/capix-memory';
import { ModelExchanges, ModelExchangeResource } from '@weiliang0121/capix-model-exchanges';
import { AnthropicMessagesProvider, OpenAIResponsesProvider, GeminiGenerateContentProvider, ChatCompletionsProvider, requireModelReply, requireModelRequest } from '@weiliang0121/capix-model-provider';
import { encodeUtf8, utf8ByteLength, decodeBase64 } from '@weiliang0121/capix-platform/bytes';
import { randomUUID } from '@weiliang0121/capix-platform/identity';
import { createSha256 } from '@weiliang0121/capix-platform/hash';
import { acceptTranscriptUpdate } from '@weiliang0121/capix-protocol';
import { bindRecording } from '@weiliang0121/capix-recording';
import { BaseRecord, RecordBook, Recorder } from '@weiliang0121/capix-records';
import { Resource, ResourceOffer, ResourceAccessClosed, Resources } from '@weiliang0121/capix-resources';
import { Runner, Resources as RunnerResources, checkpointPoint } from '@weiliang0121/capix-runtime';
import { Scene, Node, Dynamic, Sequence } from '@weiliang0121/capix-structure';
import { Tool, ToolModelResource } from '@weiliang0121/capix-tool';
import { Transcript, TranscriptResource, TranscriptViewSource } from '@weiliang0121/capix-transcript';
import { View } from '@weiliang0121/capix-view';
import { z } from 'zod';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const request = { messages: [{ role: 'user', content: 'echo' }] };
const contract = { key: 'matrix.model.v1', request: requireModelRequest, reply: requireModelReply };

const probes = {
  'Host UUID allocation'() {
    const a = randomUUID();
    const b = randomUUID();
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    check(v4.test(a) && v4.test(b) && a !== b, 'expected distinct v4 UUIDs');
  },
  'UTF-8 and base64 bytes'() {
    const text = '雪💾';
    const expected = [233, 155, 170, 240, 159, 146, 190];
    check(utf8ByteLength(text) === expected.length && Array.from(encodeUtf8(text)).join() === expected.join(), 'UTF-8 bytes');
    check(Array.from(decodeBase64('6Zuq8J+Svg==')).join() === expected.join(), 'base64 bytes');
  },
  'SHA-256 fork and finalize'() {
    const prefix = createSha256().update('a');
    check(prefix.copy().update('bc').digestHex() === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'fork digest');
    check(prefix.digestHex() === 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', 'prefix digest');
  },
  'Checkpoint fingerprint and negative zero'() {
    const value = createCheckpointValueBlock('fixture', -0);
    check(value.digest === '4acd3d123e9a682812ae071d3e0c942056e2aded58e2268779991cf3b22b3f94', 'block digest');
    check(value.digest !== createCheckpointValueBlock('fixture', 0).digest, 'signed zero collapsed');
    check(Object.is(decodeCheckpointData(encodeCheckpointData(value.value)), -0), 'negative zero was lost');
  },
  'Frame v6 save and read'() {
    const store = new MemoryCheckpointStore();
    const receipt = store.save({ id: 'image', formatVersion: 6, contract: { key: 'fixture', version: 1 }, point: 'saved', frame: { owner: { contextId: 'call', kind: 'node' }, round: 1, phase: 'execute', input: 'in', currentInput: null, nextChildOrder: 0, children: [] }, state: 'saved', references: {} }, 0);
    check(receipt.revision === 1 && store.read('call').image.state === 'saved', 'checkpoint read');
  },
  'Resource operation and revocation': async () => {
    const offer = new ResourceOffer({ methods: { read: (value) => value } });
    const access = new Resources().register(new Resource('answer'), offer).bind({ value: offer.request() }).open();
    const endpoint = access.endpoints.value;
    try {
      check((await endpoint.read()) === 'answer', 'resource read');
    } finally {
      access.close();
    }
    let failure;
    try {
      await endpoint.read();
    } catch (error) {
      failure = error;
    }
    check(failure instanceof ResourceAccessClosed, 'resource remained open');
  },
  'Explicit reception permit across await': async (trace) => {
    const parent = new InvocationContext(null);
    parent.start();
    const children = new InvocationChildren(parent);
    const foreign = new InvocationChildren(new InvocationContext(null));
    const transcript = new Transcript();
    const access = new Resources()
      .register(new Resource(transcript), TranscriptResource.append)
      .bind({ messages: TranscriptResource.append.request() })
      .open({
        contextId: parent.id,
        failures: invocationResourceFailures,
        validate: () => children.requireHealthy(),
        reception: (permit) => children.resolveReception(permit),
      });

    function waitingChild(value) {
      const child = new InvocationContext(null);
      child.complete(value);
      const relation = children.attach({ context: child, run: async () => value });
      relation.returnedWith({ status: 'succeeded', output: value });
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const accepted = relation.accept(async (output, permit) => {
        entered.resolve(permit);
        await release.promise;
        const origin = children.resolveReception(permit);
        check(origin.parentContextId === parent.id && origin.childContextId === child.id, 'wrong permit origin');
        const receipt = access.endpoints.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: output }] }, permit);
        trace('appended ' + output);
        return receipt.start;
      });
      return { child, relation, entered: Promise.race([entered.promise, accepted]), release, accepted };
    }
    function requireRejected(owner, permit) {
      let failure;
      try {
        owner.resolveReception(permit);
      } catch (error) {
        failure = error;
      }
      check(/active direct-child reception permit/.test(String(failure)), 'unexpected permit admission');
    }
    const first = waitingChild('first');
    const second = waitingChild('second');
    try {
      const [a, b] = await Promise.all([first.entered, second.entered]);
      check(a !== b && first.relation.reception.status === 'receiving' && second.relation.reception.status === 'receiving', 'siblings did not overlap');
      check(children.resolveReception(a).childContextId === first.child.id && children.resolveReception(b).childContextId === second.child.id, 'concurrent permit attribution');
      requireRejected(foreign, a);
      requireRejected(foreign, b);
      trace('overlapping siblings resolved and foreign parent rejected');
      second.release.resolve();
      check((await second.accepted) === 0 && second.relation.reception.status === 'accepted', 'second child reception');
      requireRejected(children, b);
      check(first.relation.reception.status === 'receiving' && children.resolveReception(a).childContextId === first.child.id, 'sibling exit revoked live permit');
      first.release.resolve();
      check((await first.accepted) === 1 && first.relation.reception.status === 'accepted', 'first child reception');
      requireRejected(children, a);
      const [secondAppend, firstAppend] = transcript.exportState().appends;
      check(secondAppend.request.operation.parentContextId === parent.id && secondAppend.request.operation.childContextId === second.child.id && firstAppend.request.operation.parentContextId === parent.id && firstAppend.request.operation.childContextId === first.child.id, 'fixed append provenance');
      check(transcript.length === 2 && transcript.get(0).content === 'second' && transcript.get(1).content === 'first', 'fixed append order');
      trace('both permits expired and stored append origins match');
    } finally {
      first.release.resolve();
      second.release.resolve();
      await Promise.allSettled([first.accepted, second.accepted]);
      access.close();
    }
  },
  'Typed fact delivery'() {
    const type = new FactType('probe');
    let output;
    check(
      type.match(type.create('fact'), (event) => {
        output = event;
      }) && output === 'fact',
      'fact dispatch',
    );
  },
  'Stable nested data'() {
    const source = { rows: ['fixed'] };
    const result = stableValue(source);
    source.rows[0] = 'changed';
    check(Object.isFrozen(result.rows) && result.rows[0] === 'fixed', 'stable data isolation');
  },
  'Error diagnostic'() {
    const detail = RuntimeErrorHelper.format(new Error('fixture'));
    check(detail.message === 'fixture', 'diagnostic message');
  },
  'Record registration'() {
    const recorder = new Recorder(new RecordBook());
    class FixtureRecord extends BaseRecord {}
    const record = recorder.add(new FixtureRecord('entry'));
    check(recorder.book.get(record.id) === record && record.value === 'entry', 'record identity');
  },
  'Memory create and restore'() {
    const memories = new Memories();
    const item = memories.apply([{ action: 'create', value: { content: 'first' } }]).changed[0];
    const restored = Memories.restore(memories.exportState());
    check(restored.values()[0].id === item.id && restored.values()[0].value.content === 'first', 'memory restore');
  },
  'Transcript append and restore'() {
    const transcript = new Transcript();
    transcript.append({ role: 'assistant', content: 'first' });
    check(Transcript.restore(transcript.exportState()).get(0).content === 'first', 'transcript restore');
  },
  'Message identity counting'() {
    const message = Object.freeze({ role: 'assistant', content: 'count' });
    const usage = new MessageUsage();
    usage.add([message, message]);
    check(usage.get(message) === 1 && usage.get(Object.freeze({ ...message })) === 0, 'usage identity');
  },
  'Wire baseline admission'() {
    const original = { type: 'baseline', snapshot: { id: 'source', revision: 1, start: 0, end: 1, starts: [0], messages: [{ role: 'assistant', content: 'body' }] } };
    const fixed = acceptTranscriptUpdate(original);
    check(fixed.snapshot.messages[0].content === 'body' && Object.isFrozen(fixed.snapshot.messages), 'wire admission');
  },
  'Independent interaction send and feedback': async (trace) => {
    const text = { key: 'fixture.text.v1', request: (value) => value, reply: (value) => value };
    let sends = 0;
    const registry = new Interactions().register(text, {
      persistence: {
        create() {
          trace('prepared state saved');
        },
        commit({ state }) {
          trace('saved revision ' + state.revision);
        },
      },
      send(value) {
        trace('sender entered');
        sends++;
        return value + '!';
      },
    });
    const channel = registry.bind(text);
    trace('registered channel bound');
    const ref = channel.start('ok');
    await registry.settled();
    const read = channel.read(ref);
    check(read.kind === 'received' && read.feedback.payload === 'ok!' && sends === 1, 'interaction delivery ' + JSON.stringify(read));
  },
  'Runner primitive input and output': async (trace) => {
    const scene = new Scene({ run: (work) => work.input + 1 });
    trace('scene constructed');
    const runner = new Runner(scene, new RunnerResources());
    trace('runner constructed');
    runner.build();
    trace('runner built');
    check((await runner.run(41)) === 42 && !runner.isRunning, 'runner output');
  },
  'Sequence propagates each result': async () => {
    const steps = [];
    const one = new Node({
      run(work) {
        steps.push(work.input);
        return work.input + 1;
      },
    });
    const two = new Node({
      run(work) {
        steps.push(work.input);
        return work.input * 2;
      },
    });
    const runner = new Runner(new Scene(new Sequence([one, two])), new RunnerResources()).build();
    check((await runner.run(4)) === 10 && steps.join(',') === '4,5', 'sequence order and inputs');
  },
  'Dynamic selects the requested member': async () => {
    let result;
    const options = Object.fromEntries(
      ['left', 'right'].map((key) => [
        key,
        new Node({
          run(work) {
            result = key + '-' + work.input;
          },
        }),
      ]),
    );
    const decide = new Node({ run: (work) => (result === undefined ? { kind: 'call', option: work.input, input: 'chosen' } : { kind: 'finish', value: result }) });
    const runner = new Runner(new Scene(new Dynamic({ options, decide, maxSteps: 1 })), new RunnerResources()).build();
    for (const key of ['right', 'left']) {
      result = undefined;
      check((await runner.run(key)) === key + '-chosen', 'dynamic member routing');
    }
  },
  'Runner cold checkpoint resume': async (trace) => {
    const codec = { encode: cloneCheckpointValue, decode: cloneCheckpointValue };
    let encoded;
    let normal = 0;
    let resumes = 0;
    class CapturingStore extends MemoryCheckpointStore {
      save(image, revision) {
        const receipt = super.save(image, revision);
        encoded = encodeCheckpointData(this.read(receipt.contextId));
        return receipt;
      }
    }
    function build(store) {
      const point = checkpointPoint()({
        name: 'ready',
        state: codec,
        references: {},
        resume: {
          run(work, state) {
            resumes++;
            check(work.input === state.input && Object.is(state.zero, 0) && Object.is(state.negativeZero, -0), 'restored input and signed zeros');
            return state.answer;
          },
        },
      });
      const scene = new Scene({
        checkpoint: { key: 'matrix.resume', version: 1, input: codec, output: codec, points: [point] },
        run(work) {
          normal++;
          const answer = work.input + 1;
          work.checkpoint({ point, state: { input: work.input, answer, zero: 0, negativeZero: -0 }, refs: {} });
          return answer;
        },
      });
      return new Runner(scene, new RunnerResources(), { checkpoints: { store } }).build();
    }
    const first = new CapturingStore();
    check((await build(first).run(41)) === 42, 'first run output');
    const pending = cloneCheckpointHead(decodeCheckpointData(encoded));
    const id = pending.image.frame.owner.contextId;
    check(!pending.delivery && first.read(id).delivery.status === 'succeeded', 'capture prior to terminal delivery');
    trace('saved explicit point before final delivery');
    const cold = new MemoryCheckpointStore();
    cold.save(pending.image, 0);
    check((await build(cold).resume(id)) === 42 && normal === 1 && resumes === 1 && cold.read(id).delivery.status === 'succeeded', 'cold continuation or completion');
    trace('fresh runner resumed saved point once');
  },
  'Recording observed invocations': async () => {
    const recorder = new Recorder(new RecordBook());
    const runner = new Runner(new Scene(new Node({ run: (work) => work.input })), new RunnerResources(), { observations: [bindRecording(recorder)] }).build();
    check((await runner.run('observed')) === 'observed', 'observed result');
    check([...recorder.book.values()].filter((record) => record.kind === 'invocation' && record.status === 'succeeded').length === 2, 'observed invocation count');
  },
  'Model request admission'() {
    check(requireModelRequest(request) === request, 'model request admission');
  },
  'Model exchange origin and request'(trace) {
    const entity = new ModelExchanges();
    trace('entity constructed');
    const origin = entity.begin('first', { request, catalog: { tools: [], digest: 'catalog', policyVersion: '1' } });
    trace('origin admitted');
    check(entity.request({ origin, exchanges: [] }).messages[0].content === 'echo', 'exchange request');
  },
  'View capture': async (trace) => {
    const transcript = new Transcript([{ role: 'assistant', content: 'view' }]);
    const source = new TranscriptViewSource(transcript);
    trace('source constructed');
    const view = new View({ revision: 0, sources: { text: { id: source.id, scope: source.scope } }, members: [{ source: 'text', key: 0 }] });
    trace('view constructed');
    check((await view.capture({ text: source })).entries[0].value.content === 'view', 'view snapshot');
  },
  'Anthropic Messages JSON': (_trace, transport) => checkProvider('anthropic-messages', transport),
  'OpenAI Responses JSON': (_trace, transport) => checkProvider('openai-responses', transport),
  'Gemini generateContent JSON': (_trace, transport) => checkProvider('gemini-generate-content', transport),
  'Tool JSON selection and feedback': (trace, transport) => runTool(false, trace, transport),
  'Tool SSE selection and feedback': (trace, transport) => runTool(true, trace, transport),
};

const providerCases = {
  'anthropic-messages': {
    Provider: AnthropicMessagesProvider,
    path: '/v1/messages',
    config: { maxTokens: 50, anthropicVersion: '2023-06-01' },
    wire: { type: 'message', role: 'assistant', id: 'm1', model: 'offline', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  },
  'openai-responses': {
    Provider: OpenAIResponsesProvider,
    path: '/v1/responses',
    wire: { object: 'response', id: 'r1', model: 'offline', status: 'completed', error: null, incomplete_details: null, store: false, previous_response_id: null, output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }] },
  },
  'gemini-generate-content': {
    Provider: GeminiGenerateContentProvider,
    path: '/v1beta/models/offline:generateContent',
    wire: { responseId: 'r1', modelVersion: 'offline', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }] },
  },
};
async function checkProvider(format, transport) {
  const item = providerCases[format];
  const endpoint = new URL(item.path, transport?.endpoint ?? 'https://matrix.invalid').href;
  const provider = new item.Provider({ endpoint, model: 'offline', apiKey: 'fixture', bindingId: 'fixture', ...item.config, fetch: transport?.fetch ?? fixtureFetch });
  const reply = requireModelReply(await provider.complete(request));
  check(reply.native.format === format && reply.termination.kind === 'completed' && reply.output[0].text === 'done', 'provider output');
}

// The app's loopback HTTP server and the default offline fetch use identical wire messages.
export function modelFixtureResponse(body, path = '/completions') {
  if (path !== '/completions') {
    const item = Object.values(providerCases).find((candidate) => candidate.path === path);
    check(item && JSON.stringify(body).includes('"echo"'), 'unexpected offline protocol request');
    return { contentType: 'application/json', parts: [JSON.stringify(item.wire)] };
  }
  const feedback = body.messages.find((message) => message.role === 'tool');
  const reason = feedback ? 'stop' : 'tool_calls';
  if (feedback) check(feedback.tool_call_id === 'echo1' && JSON.parse(feedback.content).content[0].text === 'done', 'tool feedback on wire');
  check(body.tools[0].function.name === 'echo', 'tool catalog on wire');
  const call = { id: 'echo1', type: 'function', function: { name: 'echo', arguments: '{"word":"done"}' } };
  const base = { id: feedback ? 'answer' : 'choice', model: 'offline' };
  if (!body.stream) {
    const message = { role: 'assistant', content: feedback ? 'done' : null, ...(feedback ? {} : { tool_calls: [call] }) };
    return { contentType: 'application/json', parts: [JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason: reason }] })] };
  }
  const deltas = feedback ? [{ content: 'do' }, { content: 'ne' }] : [{ tool_calls: [{ ...call, index: 0 }] }];
  const parts = deltas.map((delta) => 'data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  parts.push('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reason }] }) + '\n\n', 'data: [DONE]\n\n');
  return { contentType: 'text/event-stream', parts };
}

async function fixtureFetch(url, init) {
  const wire = modelFixtureResponse(JSON.parse(init.body), new URL(url).pathname);
  const body = new ReadableStream({
    start(controller) {
      for (const part of wire.parts) controller.enqueue(encodeUtf8(part));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': wire.contentType } });
}

async function runTool(stream, trace, transport) {
  const node = new Node({ run: (work) => work.input.word });
  trace('node constructed');
  const tool = new Tool({ policyVersion: 'v1', tools: { echo: { node, description: 'Echo a word', input: z.strictObject({ word: z.string() }), result: { succeeded: (text) => ({ status: 'ok', content: [{ kind: 'text', text }] }) } } } });
  trace('tool constructed');
  const provider = new ChatCompletionsProvider({ model: 'offline', apiKey: 'fixture', endpoint: transport?.endpoint ?? 'https://matrix.invalid/completions', fetch: transport?.fetch ?? fixtureFetch });
  let calls = 0;
  const deltas = [];
  const registry = new Interactions().register(contract, {
    send(input) {
      calls++;
      return provider.complete(input, { emit: (text) => deltas.push(text) });
    },
  });
  const exchanges = new ModelExchanges();
  const resources = new RunnerResources().register(new Resource(exchanges), ModelExchangeResource).register(new Resource({ exchanges, channel: registry.bind(contract), inspection: provider }), ToolModelResource);
  const runner = new Runner(new Scene(tool), resources).build();
  trace('runner built');
  const output = await runner.run({ request: { ...request, stream } });
  check(output === 'done' && calls === 2, 'offline tool output and send count');
  if (stream) check(deltas.join('') === 'done', 'streamed text');
  trace('tool feedback encoded and final output accepted');
}

export async function runFeatureMatrix(transport) {
  const rows = [];
  for (const [feature, probe] of Object.entries(probes)) {
    const steps = [];
    try {
      await probe((step) => steps.push(step), transport);
      rows.push({ feature, steps, status: 'passed' });
    } catch (error) {
      rows.push({ feature, steps, status: 'failed', error: String(error), cause: error?.cause && String(error.cause), stack: error?.stack });
    }
  }
  return rows;
}
