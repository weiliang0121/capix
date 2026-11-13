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
- [按主题实践](https://weiliang0121.github.io/capix/examples/)：结构、资源、实体、输出和记录的可运行示例。
- [参考与契约](https://weiliang0121.github.io/capix/README.html)：准确的 API、生命周期与承诺边界。

已发布的基础包可从 npm 安装，运行环境为 **Node.js 22.23.2 或更新版本**：

```sh
npm install @weiliang0121/capix-resources @weiliang0121/capix-structure @weiliang0121/capix-runtime
```

完整包职责见[架构与包](https://weiliang0121.github.io/capix/organization.html)。目前处于 **0.x** 阶段，文档跟随主分支，包含尚未发布的变更；Tool 预设尚未发布，便签助手教程请使用仓库源码。使用 npm 包时，以所装版本的 README 和 CHANGELOG 为准。

## 参与贡献

欢迎报告问题、分享具体使用场景，或改进代码、测试与文档。问题尽量附上可独立运行的最小复现；涉及设计调整时，说明希望解决的场景与现有边界。

开发环境、检查命令和 PR 约定见[贡献指南](CONTRIBUTING.md)。文档源码位于 [docs/](docs/README.md)，可运行示例位于 [examples/](examples/README.md)。安全问题请按[安全说明](SECURITY.md)处理。

## 创作与致谢

CAPiX 由 [wei.liang](https://github.com/weiliang0121) 与 Codex 共同设计和实现。从最初的想法到架构、代码与验证，项目在持续的讨论与协作中逐步成形。

也感谢 GPT-6 Astra 及其他 Agent 在讨论、分析和交叉审查中提供的意见。

## 许可

[MIT](LICENSE) © wei.liang
