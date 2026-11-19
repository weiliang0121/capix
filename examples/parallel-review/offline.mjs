import assert from 'node:assert/strict';

// 只替代外部模型。工具返回实际可读材料；各项断言也会随 CLI 一起执行。
export function createOfflineReview(modules) {
  const expectedOrder = [...modules];
  if (modules.length > 1) [expectedOrder[0], expectedOrder[1]] = [modules[1], modules[0]];
  const gates = new Map(expectedOrder.map((module) => [module, Promise.withResolvers()]));
  const completed = [];
  let verifications = 0;
  return {
    expectedOrder,
    completed,
    get verifications() {
      return verifications;
    },
    accepted(module) {
      completed.push(module);
      gates.get(module).resolve();
    },
    release() {
      for (const gate of gates.values()) gate.resolve();
    },
    async complete(request) {
      const user = request.messages.find((message) => message.role === 'user').content;
      let output;
      if (request.tools?.length) {
        const feedback = request.exchanges?.at(-1)?.feedback[0];
        if (!feedback) {
          output = { kind: 'tool-call', id: 'read', name: 'readChanges', arguments: { encoding: 'json-text', text: '{}' } };
        } else {
          assert.equal(feedback.status, 'ok');
          const changes = JSON.parse(feedback.content[0].text);
          assert.deepEqual(
            changes.map(({ module }) => module),
            [user],
            '工具只能读到当前审阅模块',
          );
          const key = changes[0].patch.match(/(?:options\.|Set )(\w+)/u)?.[1];
          assert.ok(key, '离线脚本预期改动中包含配置项');
          const predecessor = expectedOrder[expectedOrder.indexOf(user) - 1];
          if (predecessor) await gates.get(predecessor).promise;
          output = { kind: 'text', text: `${user === 'docs' ? '文档写的是' : '实现读取'} ${key}` };
        }
      } else {
        verifications++;
        const findings = JSON.parse(user);
        assert.deepEqual(
          findings.map(({ module }) => module),
          modules,
        );
        assert.equal(completed.length, findings.length);
        const api = findings.find(({ module }) => module === 'api');
        const docs = findings.find(({ module }) => module === 'docs');
        const apiKey = api?.finding.split(' ').at(-1);
        const docKey = docs?.finding.split(' ').at(-1);
        let text = '缺少 API 或文档的审阅结果，无法核对两端的配置项。';
        if (api && docs) text = apiKey === docKey ? '文档与 API 使用相同的配置项。' : `文档的 ${docKey} 与 API 的 ${apiKey} 不一致，请对齐名称和单位。`;
        output = { kind: 'text', text };
      }
      return { formatVersion: 1, id: `offline-${output.kind}`, model: 'offline-fixed-script', output: [output], termination: { kind: 'completed', reason: output.kind === 'text' ? 'stop' : 'tool_calls' }, usage: null, native: { format: 'chat-completions', version: 1 } };
    },
  };
}
