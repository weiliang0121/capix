import assert from 'node:assert/strict';
import { z } from 'zod';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Group, Node, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Interactions } from '@weiliang0121/capix-interaction';
import { modelReplyText, requireModelRequest, requireModelReply } from '@weiliang0121/capix-model-provider';
import { ModelExchangeResource, ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { Tool, ToolModelResource } from '@weiliang0121/capix-tool';
import { createOfflineReview } from './parallel-review/offline.mjs';

const changes = [
  { module: 'api', patch: '+ const timeout = options.timeoutMs;' },
  { module: 'cache', patch: '+ const ttl = options.ttlSeconds;' },
  { module: 'docs', patch: '+ Set timeoutSeconds in your client options.' },
];

// #region scope
const materials = new ResourceOffer({
  refine(available, module) {
    const selected = available.filter((change) => change.module === module);
    if (!selected.length) throw new Error(`没有可供审阅的模块：${module}`);
    return selected;
  },
  methods: { read: (available) => available },
});
const readChanges = new Node({
  deps: { changes: materials.request() },
  run: (work) => work.resources.changes.read(),
});
// #endregion scope

// #region review
const inspect = new Tool({
  policyVersion: 'parallel-review.v1',
  tools: {
    readChanges: {
      node: readChanges,
      description: 'Read the changes available to this reviewer.',
      input: z.strictObject({}),
      result: { succeeded: (changes) => ({ status: 'ok', content: [{ kind: 'text', text: JSON.stringify(changes) }] }) },
    },
  },
});
const review = new Group({
  run: (work) =>
    work.children.invoke(inspect, {
      request: {
        messages: [
          { role: 'system', content: '读取模块改动，报告配置项的命名或单位。' },
          { role: 'user', content: work.input },
        ],
      },
    }),
}).add(inspect);
// #endregion review

// #region verify
const verificationModel = new ResourceOffer({
  methods: {
    async complete(channel, request, operation) {
      const ref = channel.start(request);
      const reply = await channel.wait(ref, { waitMs: 5000, signal: operation.signal });
      if (reply.kind !== 'received') throw new Error(`复核模型未返回：${reply.kind}`);
      return modelReplyText(reply.feedback.payload);
    },
  },
});
const verify = new Node({
  deps: { model: verificationModel.request() },
  run: (work) =>
    work.resources.model.complete({
      messages: [
        { role: 'system', content: '核对模块发现，指出文档和实现之间的不一致。' },
        { role: 'user', content: JSON.stringify(work.input) },
      ],
    }),
});
// #endregion verify

// #region coordinator
function createCoordinator(onReviewed) {
  return new Group({
    async run(work) {
      const findings = await Promise.all(
        work.input.map(async (module) => {
          const finding = await work.children.invoke(review, module);
          onReviewed(module); // 宿主可以观察各模块实际交回的顺序。
          return { module, finding };
        }),
      );
      const conclusion = await work.children.invoke(verify, findings);
      return { findings, conclusion };
    },
  }).add({ review, verify });
}
// #endregion coordinator

async function runReview(modules) {
  const script = createOfflineReview(modules);
  const coordinator = createCoordinator(script.accepted);

  // #region wiring
  const contract = { key: 'parallel-review.model.v1', request: requireModelRequest, reply: requireModelReply };
  const interactions = new Interactions().register(contract, { send: (request) => script.complete(request) });
  const exchanges = new ModelExchanges();
  const resources = new Resources()
    .register(new Resource(changes), materials)
    .refine(
      review,
      materials.refine((module) => module),
    )
    .register(new Resource(exchanges), ModelExchangeResource)
    .register(new Resource({ exchanges, channel: interactions.bind(contract) }), ToolModelResource)
    .registerInteraction(verificationModel, contract);
  const runner = new Runner(new Scene(coordinator), resources, interactions).build();
  // #endregion wiring
  try {
    const result = await runner.run(modules);
    assert.deepEqual(script.completed, script.expectedOrder);
    assert.deepEqual(
      result.findings.map(({ module }) => module),
      modules,
    );
    assert.equal(script.verifications, 1);
    return { ...result, completed: script.completed };
  } finally {
    script.release();
    await interactions.settled();
    interactions.close();
  }
}

const args = process.argv.slice(2);
const knownModules = changes.map(({ module }) => module);
const modules = args.length ? args : knownModules;
if (new Set(modules).size !== modules.length || modules.some((module) => !knownModules.includes(module))) throw new Error(`请选择不重复的模块：${knownModules.join(', ')}`);
const { completed, findings, conclusion } = await runReview(modules);
console.log(`完成顺序：${completed.join(' → ')}`);
for (const { module, finding } of findings) console.log(`${module}：${finding}`);
console.log(`复核：${conclusion}`);
