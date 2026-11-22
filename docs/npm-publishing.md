# npm 发布

CAPiX 采用 MIT。发布包包含编译后的 ESM JavaScript、类型声明、README、该包的 CHANGELOG 和 LICENSE；源码仓库仍可保持私有。MIT 允许接收者使用、修改和再分发，保留相应版权及许可声明。压缩与去注释用于减少分发体积，不能保护 JavaScript 实现不被阅读。

## 范围与版本

公开范围为 `packages/` 中的 21 个 `@weiliang0121/capix-*` 包，包含 `capix-tool`，由 `scripts/release/packages.mjs` 显式列举。根包仍为私有。文档站、示例和具体应用不属于公开包分发批次。公开包使用 Changesets 独立发版，不设置 fixed 或 linked 版本组。内部依赖使用 `workspace:*`，打包时转换为依赖目标各自的准确版本，包之间可以使用不同版本号。

各包 CHANGELOG 负责说明自身变更、依赖兼容性和迁移要求；package.json 与实际 tarball 仍是安装器使用的依赖事实，不能只写兼容说明而保留错误的机器依赖。上层包使用新依赖版本时按实际需要更新版本和说明，无依赖关系的包不共同升号。例如 Tool 新增能力可单独发布 `0.8.0`，继续依赖已有的其他包 `0.7.0`。完整清单验证覆盖全部公开包；上传只处理本次计划中尚未发布的准确包名和版本。

公开包统一使用 `@weiliang0121/capix-<职责>`，其中 Runner 所在包仍为 `@weiliang0121/capix-runtime`。包边界与职责见[架构与包](organization.md#包的所有者)。私有包不在 npm 发布清单；不要从其他项目取得 npm 凭证。

后续包名仍按可复用职责确定，必要限定词放在主体之前；不把 `server`、`services`、`apps` 等源码目录自动映射成发布名称。预设、集成与 UI 只有在职责和公开边界确定后才单独命名，参考装配不直接变成产品包。

新增公开包需要明确职责、公开出口、独立测试与许可，再加入公开包分发清单。

## 本地验证

使用仓库声明的 Node 22.23.2 和 pnpm 10.7.1，依赖通过官方 registry 安装：

```sh
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm check
pnpm release:check
```

`release:build` 为公开包清理并重建发布产物，移除内部注释并压缩 JavaScript；不进行跨包 bundle，不混合依赖实体身份。`release:check` 构建并检查实际 tarball，验证包白名单、入口、内部依赖和仓库外消费者安装。原始 `.ts`、实现 source map、声明 map、测试、服务和内部文档不应进入 tarball。公开 `.d.ts` 本身会暴露必要类型结构。

## GitHub 版本 PR 与正式发布

Changesets 根据实际变更创建 `changeset-release/main` 版本 PR。维护者审阅各包版本、CHANGELOG、内部依赖和锁文件，确认 CI 通过后 squash 合并。GitHub Actions 创建版本 PR 所需的权限是 `contents: write` 与 `pull-requests: write`。机器人创建或更新版本 PR 后，维护者按需要批准该 PR 的 CI。

[Publish release](https://github.com/weiliang0121/capix/actions/workflows/publish.yml) 在 main push 时读取该提交关联的 PR。只有来自本仓版本分支、以该 SHA 合入 main 的版本 PR 才进入准备。手动运行时选择 main 并输入版本 PR 编号，所选 main 的 SHA 必须仍是该合并提交。原运行保留其触发 SHA，main 继续前进也能在原运行中完成批准和交付。

1. **准备。** GitHub-hosted runner 在合并 SHA 依次执行 `pnpm check`、`pnpm release:check`、`pnpm integration:check`。从该提交和第一父提交找出升号包，从发布验收目录读取这批包的 tarball，核对 SHA-256 后计算 npm 使用的 SHA-512 integrity。产物包括本批 tarball、`release-manifest.json` 和按包摘取的 `release-notes.md`。在 Actions 的 prepare 摘要和 artifact 中审阅这些内容。
2. **批准上传。** 在该运行的 **Review deployments** 中批准 `npm` Environment。publish job 凭 OIDC 使用固定的 npm CLI 11.11.1，按依赖顺序上传原 tarball，并请求 npm provenance。已有同版本须匹配原摘要。上传时检查 `latest`，拒绝将它移回旧版本。批准范围为整个批次。
3. **核验并公告。** 逐个核对 npm 中本批准确版本的 `dist.integrity` 后，建立指向该 SHA 的 tag `release/pr-<编号>`。一批对应一条 GitHub Release，正文包含各包准确版本、npm 链接和 CHANGELOG，附件为经过核对的批次清单。同名 tag 或 Release 存在时核验其内容，遇冲突停止。

### npm 与 GitHub 一次性设置

- 在 GitHub 仓库的 **Settings → Environments → npm** 登记维护者为 required reviewer，部署分支限定为 `main`。单维护者仓库需要允许维护者批准自己触发的部署。设置完成后，版本 PR 合并负责准备，环境批准负责授权写入 npm。
- 包维护者在 npm 上为每个待发布的公开包配置 GitHub Actions **Trusted Publisher**。Organization or user 选 `weiliang0121`，Repository 为 `capix`，Workflow filename 为 `publish.yml`，Environment 为 `npm`，授权该 workflow 直接 publish。包可在各自下次发布前完成配置。此前发布的 18 包已在 registry 注册；新增包需先确认包名、归属及 npm 对首次发布的要求。详见 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。
- 普通 CI 与准备阶段只读取仓库。上传 job 使用 `id-token: write`，公告 job 使用 `contents: write`，Actions 工作流固定到完整提交 SHA。本流程使用 GitHub-hosted runner，公开包的 provenance 关联到此次工作流和发布提交。

### 中途失败与重跑

首次写入前还须检查实际 tarball 声明的批外内部依赖，确保这些准确版本已可从 registry 安装。多包发布可能部分成功。按原 run 下载清单，先查询每个准确版本与摘要。例如 `npm view @weiliang0121/capix-tool@0.11.0 dist.integrity --registry=https://registry.npmjs.org`。提交结果未知或刚获受理时先等 registry 可见。若仍不能确定是否已提交，保留原产物并与 npm 核实。确认缺项后使用 **Re-run failed jobs**，沿用已通过 prepare 的 artifact。检查完整性冲突、tag 错指或发布正文冲突时，应先调查现有状态。

仅公告失败时重跑失败 job，已提交的 npm 包保持原状。准备产物的保留期为 90 天（受仓库保留策略约束），维护者可在发布前下载保存；原 run 的失败 job 须在 GitHub 允许的重跑窗口（创建后 30 天）内恢复。重跑全部 job 会再次准备并与已有同名 artifact 冲突。超过重跑窗口或丢失原产物时，应由维护者核实 registry 与原批次后单独处置。已有包在新的 workspace 里重打可能改变精确内部依赖，不能用同版本重打 tarball 代替。

### 首次源码对齐

[对齐 PR #6](https://github.com/weiliang0121/capix/pull/6) 将公开源码同步至已分发的版本。对齐时 npm 上的 Tool 为 0.11.0、Model Provider 为 0.9.0、Interaction 为 0.8.0、Runtime 和 Model Exchanges 为 0.7.1，其他 13 包为 0.7.0。历史版本以 registry 中的 tarball 及其依赖为准；新流程从后续版本 PR 开始记录批次。

## 候选分发

`pnpm integration:pack` 干净构建 21 个公开包，生成 `.capix/integration` tarball 批次，不发布 npm。manifest 记录源码提交、dirty 状态、源文件摘要和每个产物的 SHA256；文件白名单包含包清单、编译产物、声明、README、CHANGELOG 与许可。

`pnpm integration:check` 在仓库外临时消费者中安装这批包，核对依赖、公开出口、运行结果和类型。消费方若要接入候选，须按准确 manifest 校验完整批次并维护自己的锁文件，不能混用不同源码批次的同版本包，也不能绕过公开出口读取私有 src/dist。

候选包和压缩发布包分别生成、分别验证，源码版本相同不意味着 tarball 字节相同。消费方的业务策略、持久 codec 和恢复资格需要自行适配；框架分发验证不替任意应用保证其升级完成。
