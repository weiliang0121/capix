# 参考与契约

这里用于查阅准确的 API、生命周期、失败行为和承诺边界。内容描述仓库当前实现；使用已发布版本时，应核对相应版本的包 README 和 CHANGELOG。

## 按你的问题选择入口

- **第一次构建：** [便签助手教程](guide/getting-started.md)。先运行完整任务，再通过七课拆解、验证和扩展同一个项目。
- **理解设计：** [核心概念](concepts/index.md)。每个维度说明是什么、如何使用、为何这样划分；[Why CAPiX](why.md)说明起点与适用范围。
- **尝试一种能力：** [按主题实践](examples/index.md)。围绕结构、资源、实体、输出和记录运行独立例子。
- **核对精确行为：** 从下面的契约表进入。包间依赖与运行环境见[架构与包](organization.md)。

## 契约索引

| 主题           | 入口                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 结构与装配     | [结构](structure-package.md)、[可调用结构](callable-structures.md)、[资源](resources-package.md)                                                  |
| 调用与故障     | [运行边界](runtime-boundaries.md)、[退出](invocation-exit-contract.md)、[异常](exceptions.md)、[运行出口](runtime-ports.md)                       |
| 数据与材料     | [实体](content-entities-packages.md)、[Transcript](transcript.md)、[Memory](memory.md)、[View](view-package.md)、[自定义实体](custom-entities.md) |
| 外部交互与工具 | [交互](interactions.md)、[模型与工具](native-tool-integration.md)、[Tool API](../packages/tool/README.md)                                         |
| 恢复           | [Checkpoint](checkpoints.md)、[有序选择](checkpoint-selection.md)、[版本支持](development-compatibility.md)                                       |
| 记录与协议     | [记录](recording.md)、[观测增量](observation-increments.md)、[契约与协议](contracts-protocol.md)、[Transcript wire](protocol.md)                  |

## 维护框架

- [贡献](../CONTRIBUTING.md)、[协作约定](../AGENTS.md)、[安全报告](../SECURITY.md)。
- [测试归属与命令](testing-organization-design.md)、[包分发与发布](npm-publishing.md)。
- [文档站构建与发布](site-publishing.md)：本地预览与 GitHub Pages。

框架契约、示例与正式测试均可仅凭本仓运行。文档站构建不读取外部仓库或个人开发资料；示例执行在 Node.js 中，网站展示不代表浏览器执行内核。
