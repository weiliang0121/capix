# 可运行示例

首次使用建议阅读文档站的[便签助手教程](https://weiliang0121.github.io/capix/guide/getting-started.html)，按需求选例子可查看[按主题实践](https://weiliang0121.github.io/capix/examples/)。本目录保存网站直接展示的可运行源码。

## 在本地运行

先在仓库根目录执行 `pnpm install --frozen-lockfile` 和 `pnpm build`，再执行 `pnpm examples:check`。默认入口与自动检查全部在本机 Node.js 中离线运行。便签助手另有显式 `--live` 入口，只有配置并主动执行时才调用真实模型。

推荐从[便签助手](notes-assistant.mjs)开始：读取两张便签、整理待办、写入新便签，然后给出最终回答。[逐步教程](../docs/guide/getting-started.md)展示真实源码、预期结果与模型配置；[Why CAPiX](../docs/why.md)沿用同一个场景解释职责边界。

```sh
node examples/notes-assistant.mjs
```

默认离线 Provider 按固定决策消费真实工具反馈，便于复现链路，不代表模型理解或生成能力。便签仅在内存中保留；正文、资源登记和运行结构在真实模型模式下相同。

## 源码入口

- [字典资源工厂](dictionary.mjs)、[Runner](runner.mjs)：结构、资源与装配的最小起点。
- [预设工厂](presets.mjs)：Sequence／Dynamic 的结构组合。
- [Tool](tool.mjs)：离线模型选择成员并消费真实工具反馈。
- [运行输出](runner-output.mjs)、[调用退出](invocation-exit.mjs)：输出接收、真实关闭及故障归属。
- [记录](records.mjs)：独立记录实体与可选观测消费。
- [视图](view.mjs)、[成员操作](view-membership.mjs)：实体材料与成员维护；[Skill 来源](view/skills.mjs)是辅助模块。
- [自定义实体](entities.mjs)：可修订 Plan、只追加 Notes 和 Memory 共用资源、View 与调用；[作者契约](../docs/custom-entities.md)说明可选 CP／记录边界。

## 维护与验证

除工厂外，可单独运行 `node examples/<名称>.mjs`。工厂由检查器显式构造 Runner 并验证结果和状态；检查器为各入口启动独立进程，有超时保护，断言失败或未检查的新增入口都会失败。辅助模块由真实组合示例使用，不作为独立运行覆盖。

便签助手先运行 CLI，再执行 `examples/notes/verify.mjs` 的行为与失败分支检查，以及 `examples/notes/search.mjs` 的查询扩展。查询使用与助手相同的 Notes，验证运行前后读取内容的变化与只读边界；可以用 `node examples/notes/search.mjs` 独立运行。验证代码与读者的装配示例分开。默认入口、帮助、非法参数和缺少真实模型配置的分支也会检查没有网络发送。

网站的[示例入口](../docs/examples/index.md)直接导入这些源码。通过 `pnpm docs:dev` 本地查看，`pnpm docs:build` 构建，`pnpm docs:preview` 预览；网站不在浏览器内执行框架。
