import { defineConfig } from 'vitepress';
import { resolve, relative, sep } from 'node:path';

const docs = resolve(import.meta.dirname, '..');
const repository = 'https://github.com/weiliang0121/capix';
const base = (process.env.CAPIX_DOCS_BASE ?? '/').replace(/\/?$/, '/');

export default defineConfig({
  title: 'CAPiX',
  description: '独立的 C/S 可观测 Agent 框架',
  lang: 'zh-CN',
  appearance: 'dark',
  // Support preview under a subpath without fixing a hosting destination.
  base,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }]],
  outDir: resolve(docs, '.vitepress/dist'),
  themeConfig: {
    nav: [
      { text: 'Why CAPiX', link: '/why' },
      { text: '开始', link: '/guide/getting-started' },
      { text: '示例', link: '/examples/' },
      { text: '契约', link: '/README' },
    ],
    sidebar: [
      {
        text: '使用框架',
        items: [
          { text: 'Why CAPiX', link: '/why' },
          { text: '快速开始', link: '/guide/getting-started' },
          { text: '运行示例', link: '/examples/' },
          { text: '结构与资源', link: '/examples/structure' },
          { text: '实体与视图', link: '/examples/content' },
          { text: '工具、输出与记录', link: '/examples/runtime' },
          { text: '文档站部署', link: '/site-publishing' },
        ],
      },
      {
        text: '当前契约',
        items: [
          { text: '文档导航', link: '/README' },
          { text: '资源', link: '/resources-package' },
          { text: '结构', link: '/structure-package' },
          { text: '运行边界', link: '/runtime-boundaries' },
          { text: 'Checkpoint', link: '/checkpoints' },
          { text: '交互', link: '/interactions' },
          { text: 'View', link: '/view-package' },
          { text: '自定义实体', link: '/custom-entities' },
          { text: '工具接入', link: '/native-tool-integration' },
        ],
      },
    ],
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
