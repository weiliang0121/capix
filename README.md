<p align="center">
  <a href="https://weiliang0121.github.io/capix/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-dark.svg">
      <img src="docs/public/logo-light.svg" alt="CAPiX" width="88" height="88">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://weiliang0121.github.io/capix/">文档站</a> ·
  <a href="https://weiliang0121.github.io/capix/why.html">Why CAPiX</a> ·
  <a href="https://weiliang0121.github.io/capix/guide/getting-started.html">入门教程</a>
</p>

CAPiX 是一个 Agent 框架，帮助你组合已有能力，构筑自己的智能体。

- **可组合**：接入资源、组织内容，将模型与程序逐层组合成完整的工作。
- **可观测**：记录调用、资源操作与结果交接，看清实际发生的过程。
- **可恢复**：在声明的检查点保存依据，核验通过后继续推进。

## 开始使用

推荐从[构建便签助手](https://weiliang0121.github.io/capix/guide/getting-started.html)开始：先运行一个完整的工具循环，再沿同一份源码理解、拆解和扩展。示例默认离线，便签读写真实发生；接入真实模型是教程中的下一步。

- [核心概念](https://weiliang0121.github.io/capix/concepts/)：是什么、怎么用、为什么这样设计。
- 选择 Group 时，可以比较固定步骤、按状态选路和让模型连续调用工具的写法，看下一步由谁决定、父层拿到什么结果。[推进与交付的责任边界](docs/concepts/structure.md#推进与交付的责任边界)
- [多 Agent 并行协作](docs/scenarios/multi-agent.md)演示如何并行审阅变更、限定每个 Agent 可读的材料，再汇总复核。
- 从具体场景、失败用例和框架设计中生出的观察，收在[开发者手记](docs/essays/index.md)。
- [按主题实践](https://weiliang0121.github.io/capix/examples/)：结构、资源、实体、输出和记录的可运行示例。
- [参考与契约](https://weiliang0121.github.io/capix/README.html)：准确的 API、生命周期与承诺边界。

已发布的基础包可从 npm 安装，运行环境为 **Node.js 22.23.2 或更新版本**：

```sh
npm install @weiliang0121/capix-resources @weiliang0121/capix-structure @weiliang0121/capix-runtime
```

目前处于 **0.x** 阶段，各包独立发版。各包职责见[架构与包](docs/organization.md)。安装后可在包目录阅读 README 和随包提供的 CHANGELOG.md。早期 npm 包只附 README，可到[各包目录](packages/) 按包名、版本查阅 CHANGELOG。发布批次的包名、版本与源码见 [GitHub Releases](https://github.com/weiliang0121/capix/releases)。

仓库文档描述当前源码。在线文档站显示最近一次手动部署的内容，发布时间可能与源码和 npm 版本不同。

## 体验 Psi

Psi 是基于 CAPiX 构建的桌面工作台，用来开发和维护自己的智能体项目。你可以请开发 Agent 梳理代码、修改文件，或在允许本地执行后运行测试。开启「并行协作」后，主 Agent 还可以把任务分给子 Agent，再汇总结果。项目源码由你管理，可以用原来的编辑器继续开发。

公开体验包提供 DMG 和 ZIP，适用于运行 macOS 13 或更新版本的 Apple Silicon Mac。首次使用时，在设置中连接 DeepSeek 或其他兼容 Chat Completions 的模型服务，并填写自己的 API Key。[查看 Psi 体验版与下载说明](https://github.com/weiliang0121/psi-releases/tags)

## 参与贡献

欢迎报告问题、分享具体使用场景，或改进代码、测试与文档。问题尽量附上可独立运行的最小复现；涉及设计调整时，说明希望解决的场景与现有边界。

开发环境、检查命令和 PR 约定见[贡献指南](CONTRIBUTING.md)。文档源码位于 [docs/](docs/README.md)，可运行示例位于 [examples/](examples/README.md)。安全问题请按[安全说明](SECURITY.md)处理。

## 创作与致谢

CAPiX 由 [wei.liang](https://github.com/weiliang0121) 与 Codex 共同设计和实现。从最初的想法到架构、代码与验证，项目在持续的讨论与协作中逐步成形。

也感谢 GPT-6 Astra 及其他 Agent 在讨论、分析和交叉审查中提供的意见。

## 许可

[MIT](LICENSE) © wei.liang
