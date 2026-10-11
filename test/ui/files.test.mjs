import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FileResult } from '../../apps/observer/.test-dist/features/conversation/FileResult.js';
import { Composer } from '../../apps/observer/.test-dist/features/conversation/Composer.js';
import { MessageQueue } from '../../apps/observer/.test-dist/features/conversation/MessageQueue.js';
const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const task = { sourcePath: 'notes.md', output: { path: 'summary.md' } };

test('file results distinguish confirmed creation, omitted execution and uncertainty without assistant body', () => {
  const created = render(FileResult, { task, output: { status: 'created', receipt: { path: 'summary.md', bytes: 22, digest: 'a'.repeat(64) } } });
  assert.match(created, /结果文件已创建/);
  assert.match(created, /22.*字节/);
  assert.match(created, /notes.md/);
  assert.match(render(FileResult, { task, output: { status: 'not-created', path: 'summary.md', reason: 'not-started' } }), /未执行文件创建/);
  assert.match(render(FileResult, { task, output: { status: 'unconfirmed', path: 'summary.md' } }), /无法确认是否已创建/);
  assert.match(render(FileResult, { task }), /计划保存到/);
  assert.doesNotMatch(render(FileResult, { task: { output: { path: 'poem.md' } } }), /来源文件/);
  assert.match(render(FileResult, { task, output: { status: 'not-created', path: 'summary.md', reason: 'failed' } }), /保存未完成。已有回答仍可查看或复制/);
  assert.equal(render(FileResult, {}), '');
});

test('file controls require advertised capability; queue displays frozen task paths', () => {
  const props = { configured: true, loaded: true, draft: '', onDraft() {}, async onSubmit() {}, async onCancel() {}, fileDraft: { sourcePath: '', outputPath: '' }, onFileDraft() {} };
  assert.doesNotMatch(render(Composer, props), /来源文件相对路径/);
  const enabled = render(Composer, { ...props, files: { maxReadBytes: 65536, maxWriteBytes: 65536 } });
  assert.match(enabled, /来源文件相对路径/);
  assert.match(enabled, /结果文件相对路径/);
  assert.match(enabled, /不覆盖已有文件/);
  assert.match(enabled, /可在消息中说明要读取或保存的相对路径/);
  assert.match(enabled, /仅填写保存路径即可生成新文件/);
  const queue = render(MessageQueue, { queue: { waiting: [{ id: 'q', pending: '总结', fileTask: task }] }, onCancel() {} });
  assert.match(queue, /notes.md.*summary.md/);
  assert.match(queue, /撤回待发送消息 1/);
  const createOnly = render(MessageQueue, { queue: { waiting: [{ id: 'q2', pending: '摘录李白的诗', fileTask: { output: { path: 'poem.md' } } }] }, onCancel() {} });
  assert.match(createOnly, /保存结果：poem.md/);
  assert.doesNotMatch(createOnly, /undefined|→/);
});
