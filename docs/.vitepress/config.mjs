import { defineConfig } from 'vitepress';
import { resolve, relative, sep } from 'node:path';

const docs = resolve(import.meta.dirname, '..');
const repository = 'https://github.com/weiliang0121/capix';
const base = (process.env.CAPIX_DOCS_BASE ?? '/').replace(/\/?$/, '/');

const tutorial = {
  text: '构建便签助手',
  items: [
    { text: '总览：先运行完整项目', link: '/guide/getting-started' },
    { text: '1．谁拥有便签', link: '/guide/notes-entities' },
    { text: '2．把操作交给资源', link: '/guide/notes-resources' },
    { text: '3．让 Node 完成一次工作', link: '/guide/notes-nodes' },
    { text: '4．接起模型与工具循环', link: '/guide/notes-model' },
    { text: '5．装配、运行与收尾', link: '/guide/notes-running' },
    { text: '6．用失败检查理解边界', link: '/guide/notes-failures' },
    { text: '7．加一个查询，再回看全局', link: '/guide/notes-extend' },
  ],
};
const concepts = {
  text: '核心概念',
  items: [
    { text: '总览：七个维度', link: '/concepts/' },
    { text: '资源：能力的操作契约', link: '/concepts/resources' },
    { text: '实体：内容的所有者', link: '/concepts/entities' },
    { text: '结构：工作的组织', link: '/concepts/structure' },
    { text: '调用：一次工作的发生', link: '/concepts/invocation' },
    { text: '交互：独立请求与反馈', link: '/concepts/interactions' },
    { text: '观测：解释真实过程', link: '/concepts/observation' },
    { text: '恢复：依据与续接', link: '/concepts/recovery' },
  ],
};
const examples = {
  text: '按主题实践',
  items: [
    { text: '示例索引', link: '/examples/' },
    { text: '结构与资源', link: '/examples/structure' },
    { text: '实体与视图', link: '/examples/content' },
    { text: '工具、输出与记录', link: '/examples/runtime' },
  ],
};
const reading = {
  text: '阅读入口',
  items: [
    { text: 'Why CAPiX', link: '/why' },
    { text: '入门教程', link: '/guide/getting-started' },
    { text: '核心概念', link: '/concepts/' },
    { text: '参考与契约', link: '/README' },
  ],
};

export default defineConfig({
  title: 'CAPiX',
  description: '可组合、可观测、可恢复的 Agent 框架。组合已有能力，构筑自己的智能体。',
  lang: 'zh-CN',
  appearance: 'dark',
  // Support preview under a subpath without fixing a hosting destination.
  base,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }]],
  outDir: resolve(docs, '.vitepress/dist'),
  themeConfig: {
    logo: { light: '/logo-light.svg', dark: '/logo-dark.svg', alt: '' },
    nav: [
      { text: 'Why CAPiX', link: '/why' },
      { text: '教程', link: '/guide/getting-started' },
      { text: '核心概念', link: '/concepts/' },
      { text: '参考', link: '/README' },
    ],
    sidebar: {
      '/guide/': [tutorial, reading],
      '/concepts/': [concepts, reading],
      '/examples/': [examples, reading],
      '/why': [reading, tutorial],
      '/': [
        reading,
        {
          text: '工作与执行',
          items: [
            { text: '结构与成员', link: '/structure-package' },
            { text: '可调用结构', link: '/callable-structures' },
            { text: '资源与供给', link: '/resources-package' },
            { text: '运行边界', link: '/runtime-boundaries' },
            { text: '调用退出', link: '/invocation-exit-contract' },
            { text: '异常', link: '/exceptions' },
            { text: '运行出口', link: '/runtime-ports' },
            { text: '交互', link: '/interactions' },
            { text: '原生工具接入', link: '/native-tool-integration' },
          ],
        },
        {
          text: '内容与材料',
          collapsed: false,
          items: [
            { text: '实体能力', link: '/content-entities-packages' },
            { text: '自定义实体', link: '/custom-entities' },
            { text: 'Transcript', link: '/transcript' },
            { text: 'Memory', link: '/memory' },
            { text: 'View', link: '/view-package' },
          ],
        },
        {
          text: '记录与恢复',
          collapsed: false,
          items: [
            { text: '记录', link: '/recording' },
            { text: '观测增量', link: '/observation-increments' },
            { text: 'Checkpoint', link: '/checkpoints' },
            { text: '恢复选择', link: '/checkpoint-selection' },
            { text: '版本支持', link: '/development-compatibility' },
          ],
        },
        examples,
        {
          text: '架构与维护',
          collapsed: true,
          items: [
            { text: '架构与包', link: '/organization' },
            { text: '契约与协议', link: '/contracts-protocol' },
            { text: 'Transcript wire', link: '/protocol' },
            { text: '测试', link: '/testing-organization-design' },
            { text: 'GitHub 维护', link: '/github-maintenance' },
            { text: '发布', link: '/npm-publishing' },
            { text: '文档站部署', link: '/site-publishing' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: repository }],
    search: { provider: 'local' },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    sidebarMenuLabel: '目录',
    returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '切换主题',
    lightModeSwitchTitle: '切换浅色',
    darkModeSwitchTitle: '切换深色',
  },
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark-default' },
    codeCopyButtonTitle: '复制代码',
    config(md) {
      const fence = md.renderer.rules.fence;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token.info.trim() === 'mermaid') return `<CapixDiagram :source="${md.utils.escapeHtml(JSON.stringify(token.content))}" />`;
        return fence(tokens, index, options, env, self);
      };
      // Repository files outside docs remain browsable from the static site.
      // Code snippets use VitePress's native file import and are not rewritten.
      const render = md.renderer.rules.link_open ?? ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
      md.renderer.rules.link_open = (tokens, index, options, env, self) => {
        const token = tokens[index];
        const href = token.attrGet('href');
        if (href && !/^(?:[a-z]+:|\/|#)/i.test(href) && env.path) {
          const path = resolve(env.path, '..', href.split('#')[0]);
          const inside = relative(docs, path);
          if (inside.startsWith(`..${sep}`)) {
            const fromRoot = relative(resolve(docs, '..'), path).split(sep).join('/');
            if (!fromRoot.startsWith('../')) token.attrSet('href', `${repository}/blob/main/${fromRoot}${href.includes('#') ? '#' + href.split('#')[1] : ''}`);
          }
        }
        return render(tokens, index, options, env, self);
      };
    },
  },
});
