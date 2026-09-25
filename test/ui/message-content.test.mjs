import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MessageContent } from '../../apps/observer/.test-dist/components/message-content.js';

const requireApp = createRequire(new URL('../../apps/observer/package.json', import.meta.url));
const { createElement } = requireApp('react');
const { renderToStaticMarkup } = requireApp('react-dom/server');
const render = (content, markdown = true) => renderToStaticMarkup(createElement(MessageContent, { content, markdown }));

test('assistant Markdown renders structure without rewriting literal user content', () => {
  const content = '**重点**\n\n- 条目\n\n| 项目 | 值 |\n| --- | --- |\n| 预算 | 300 |\n\n```js\nconst total = 300;\n```';
  const html = render(content);
  assert.match(html, /<strong[^>]*>重点<\/strong>/);
  assert.match(html, /<li[^>]*>条目<\/li>/);
  assert.match(html, /<table/);
  assert.match(html, /const total = 300;/);
  const plain = render(content, false);
  assert.match(plain, /\*\*重点\*\*/);
  assert.doesNotMatch(plain, /<(table|strong|pre)/);
});

test('message markup cannot introduce active HTML or unsafe links', () => {
  const html = render('<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n[bad](javascript:alert%281%29)\n\n[文档](https://example.com "native tooltip")');
  assert.doesNotMatch(html, /<(script|iframe)|href="javascript:|title=/);
  assert.match(html, /href="https:\/\/example.com\/?"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('Markdown images are explicit links without automatic loading or native tooltips', () => {
  const html = render('![示例图片](https://example.com/image.png "native tooltip")');
  assert.doesNotMatch(html, /<img|<link|title=/);
  assert.match(html, /href="https:\/\/example.com\/image.png"/);
  assert.match(html, /示例图片.*查看图片/);
  const unsafe = render('![图片](javascript:alert%281%29)');
  assert.doesNotMatch(unsafe, /<img|href="javascript:/);
});
