# 离线示例

先在仓库根目录执行 `pnpm install --frozen-lockfile` 和 `pnpm build`，再执行 `pnpm examples:check`。全部示例在本机 Node.js 中运行，不调用真实模型或外部服务。

- [字典资源工厂](dictionary.mjs)、[Runner](runner.mjs)：结构、资源与装配的最小起点。
- [预设工厂](presets.mjs)：Sequence／Dynamic 的结构组合。
- [Tool](tool.mjs)：离线模型选择成员并消费真实工具反馈。
- [运行输出](runner-output.mjs)、[调用退出](invocation-exit.mjs)：输出接收、真实关闭及故障归属。
- [记录](records.mjs)：独立记录实体与可选观测消费。
- [视图](view.mjs)、[成员操作](view-membership.mjs)：实体材料与成员维护；[Skill 来源](view/skills.mjs)是辅助模块。
- [自定义实体](entities.mjs)：可修订 Plan、只追加 Notes 和 Memory 共用资源、View 与调用；[作者契约](../docs/custom-entities.md)说明可选 CP／记录边界。

除工厂外，可单独运行 `node examples/<名称>.mjs`。工厂由检查器显式构造 Runner 并验证结果和状态；检查器为各入口启动独立进程，有超时保护，断言失败或未检查的新增入口都会失败。辅助模块由真实组合示例使用，不作为独立运行覆盖。

网站的[示例入口](../docs/examples/index.md)直接导入这些源码。通过 `pnpm docs:dev` 本地查看，`pnpm docs:build` 构建，`pnpm docs:preview` 预览；网站不在浏览器内执行框架。
