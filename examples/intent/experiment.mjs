import { modelReplyText } from '@capix/model-provider';
import { createHash } from 'node:crypto';
import { Resource, ResourceOffer } from '@capix/resources';
import { Group, Node, Scene } from '@capix/structure';
import { Resources, Runner } from '@capix/server-runtime';
import { catalog, decisionInstructions, acceptDecision, DecisionContractError } from './catalog.mjs';
import { MaterialResource, createMaterial, projectMaterial } from './material.mjs';
import { conditions } from './fixtures.mjs';

const ModelResource = new ResourceOffer({
  name: 'intent.model',
  methods: { complete: (model, request, operation) => model.complete(request, { signal: operation.signal }) },
});

function errorDetail(error) {
  // 不输出任意 Provider 错误正文，避免上游诊断中混入凭据或完整请求。
  return { name: error instanceof Error ? error.name : 'UnknownError', ...(typeof error?.code === 'string' ? { code: error.code } : {}), ...(Number.isSafeInteger(error?.status) ? { status: error.status } : {}) };
}

export function createIntentScene() {
  const candidates = Object.fromEntries(
    catalog.map((entry) => [
      entry.id,
      new Node({
        name: entry.id,
        label: entry.description,
        run(work) {
          // 真正经过子调用/接纳；此处只验证路由，不生成文本、写记忆或执行 Skill。
          return { node: entry.id, mode: 'plan-only', query: work.input.query, evidence: work.input.decision.evidence };
        },
      }),
    ]),
  );
  const decide = new Node({
    name: 'recognize-intent',
    deps: { model: ModelResource.request(), material: MaterialResource.request() },
    async run(work) {
      const index = await work.resources.material.index();
      const material = projectMaterial(await work.resources.material.capture(index));
      const request = {
        messages: [
          { role: 'system', content: decisionInstructions },
          { role: 'user', content: JSON.stringify({ query: work.input, catalog, material }) },
        ],
        maxTokens: 700,
        temperature: 0,
        responseFormat: 'json_object',
      };
      // 使用标准操作接收；传输失败与模型给出的不合法决定分开呈现。
      const received = await work.resources.model.complete(request, {
        result: {
          succeeded: (reply) => ({ ok: true, reply }),
          failed: (failure) => ({ ok: false, error: errorDetail(failure) }),
        },
      });
      const serialized = JSON.stringify(request);
      const common = { material, requestBytes: Buffer.byteLength(serialized, 'utf8'), requestSha256: createHash('sha256').update(serialized).digest('hex') };
      if (!received.ok) return { ...common, status: 'provider-error', error: received.error };
      const reply = received.reply;
      const response = { ...common, raw: modelReplyText(reply), model: reply.model ?? null, usage: reply.usage ?? null, finishReason: reply.termination.reason };
      if (reply.termination.reason !== 'stop') return { ...response, status: 'contract-error', error: { code: 'unfinished-output' } };
      try {
        const decision = acceptDecision(modelReplyText(reply), material);
        return { ...response, status: decision.kind, decision };
      } catch (error) {
        if (!(error instanceof DecisionContractError)) throw error;
        return { ...response, status: 'contract-error', error: errorDetail(error) };
      }
    },
  });
  const route = new Group().add({ decide, ...candidates });
  route.run = async (work) => {
    const classified = await work.children.decide.invoke(work.input);
    if (classified.status !== 'select') return classified;
    const plan = await work.children[classified.decision.node].invoke({ query: work.input, decision: classified.decision });
    return { ...classified, plan };
  };
  return new Scene(route);
}

export async function runCase({ fixture, condition, model }) {
  const resources = new Resources().register(createMaterial(fixture, condition), MaterialResource).register(new Resource(model), ModelResource);
  const runner = new Runner(createIntentScene(), resources).build();
  const started = performance.now();
  let result;
  try {
    result = await runner.run(fixture.query);
  } catch (error) {
    result = { status: 'runtime-error', error: errorDetail(error) };
  }
  const actual = result.status === 'select' ? result.decision.node : result.status;
  const expected = fixture.expected[condition];
  return { case: fixture.id, condition, query: fixture.query, focus: fixture.focus, expected, actual, matched: actual === expected, elapsedMs: Math.round(performance.now() - started), ...result };
}

export function summarize(rows) {
  return Object.fromEntries(
    Object.keys(conditions).map((condition) => {
      const selected = rows.filter((row) => row.condition === condition);
      return [
        condition,
        {
          samples: selected.length,
          matched: selected.filter((row) => row.matched).length,
          choiceMismatch: selected.filter((row) => ['select', 'clarify', 'unsupported'].includes(row.status) && !row.matched).length,
          contractErrors: selected.filter((row) => row.status === 'contract-error').length,
          providerErrors: selected.filter((row) => row.status === 'provider-error').length,
          runtimeErrors: selected.filter((row) => row.status === 'runtime-error').length,
        },
      ];
    }),
  );
}

export async function runMatrix({ fixtures, model, selectedConditions = Object.keys(conditions), limit = 30, onResult = () => {} }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Request limit must be 1..100');
  if (!selectedConditions.length || selectedConditions.some((condition) => !Object.hasOwn(conditions, condition)) || new Set(selectedConditions).size !== selectedConditions.length) throw new TypeError('Invalid experiment conditions');
  const rows = [];
  for (const fixture of fixtures) {
    for (const condition of selectedConditions) {
      if (rows.length >= limit) return { rows, summary: summarize(rows) };
      const row = await runCase({ fixture, condition, model });
      rows.push(row);
      onResult(row);
    }
  }
  return { rows, summary: summarize(rows) };
}
