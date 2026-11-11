# 快速开始

CAPiX 是在 Node.js 宿主中运行的 C/S 可观测 Agent 框架。先用一个离线字典理解结构、资源和运行装配；网站展示源码，执行发生在本机 Node.js 中。

## 准备仓库

使用仓库指定的 Node.js 22.23.2 与 pnpm 10.7.1，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/runner.mjs
```

输出为 `你好`。这条路径只使用内存字典，不需要模型 Key 或外部服务。

## 建立资源与结构

Resource 持有字典，Offer 定义允许的查询操作；Node 申请操作，Scene 作为入口，Runner 固定接线后按次运行。

<<< ../../examples/dictionary.mjs{js}

宿主显式调用工厂，再调用 `run`：

<<< ../../examples/runner.mjs{js}

框架包的内部导入仅通过公开出口。开始新的宿主项目时按实际使用安装 `@weiliang0121/capix-structure`、`@weiliang0121/capix-resources`、`@weiliang0121/capix-runtime`；本仓示例通过 workspace 验证当前源码，具体发布范围见 [npm 发布](../npm-publishing.md)。

## 继续探索

- [结构与资源示例](../examples/structure.md)：Sequence 的固定步骤与 Dynamic 的显式决策。
- [实体与视图](../examples/content.md)：内容所有者、材料快照与视图成员。
- [工具、输出与记录](../examples/runtime.md)：离线工具反馈、输出订阅与可选记录。
- [当前契约导航](../README.md)：调用、稳定值、CP 和退出边界。

## 本地查看文档站

```sh
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

开发服务器地址以终端输出为准。构建产物位于 `docs/.vitepress/dist`。这里只提供本地开发、静态构建与预览，没有配置托管或部署。需要在子路径预览时，可在构建和预览时设置相同的 `CAPIX_DOCS_BASE`（例如 `/capix/`）。

源码片段使用 [VitePress 的文件导入](https://vuejs.github.io/vitepress/v1/guide/markdown#import-code-snippets)，直接读取仓库的 `examples/`；修改示例后重新构建即可更新网站。
