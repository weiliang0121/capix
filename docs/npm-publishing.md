# npm 发布

CAPiX 采用 MIT。发布包包含编译后的 ESM JavaScript、类型声明、README 和 LICENSE；源码仓库仍可保持私有。MIT 允许接收者使用、修改和再分发，保留相应版权及许可声明。压缩与去注释用于减少分发体积，不能保护 JavaScript 实现不被阅读。

## 范围与版本

公开范围为 `packages/` 中的 18 个 `@weiliang0121/capix-*` 包，由 `scripts/release/packages.mjs` 显式列举；新增 `capix-tool` 已纳入该清单但尚未发布；此前目录迁移未改已有包名、版本或公开出口。根包仍为私有。文档站、示例和具体应用不属于公开包分发批次。公开包属于同一个 Changesets fixed 组，内部依赖使用 `workspace:*`，打包时转换为准确版本。

公开包统一使用 `@weiliang0121/capix-<职责>`，其中 Runner 所在包仍为 `@weiliang0121/capix-runtime`。包边界与职责见[架构与包](organization.md#包的所有者)。私有包不在 npm 发布清单；不要从其他项目取得 npm 凭证。

后续包名仍按可复用职责确定，必要限定词放在主体之前；不把 `server`、`services`、`apps` 等源码目录自动映射成发布名称。预设、集成与 UI 只有在职责和公开边界确定后才单独命名，参考装配不直接变成产品包。

新增公开包需要明确职责、公开出口、独立测试与许可，再加入分发清单和版本组；源码目录或文档示例不自动成为发布包。

## 本地验证

使用仓库声明的 Node 22.23.2 和 pnpm 10.7.1，依赖通过官方 registry 安装：

```sh
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm check
pnpm release:check
```

`release:build` 为公开包清理并重建发布产物，移除内部注释并压缩 JavaScript；不进行跨包 bundle，不混合依赖实体身份。`release:check` 构建并检查实际 tarball，验证包白名单、入口、内部依赖和仓库外消费者安装。原始 `.ts`、实现 source map、声明 map、测试、服务和内部文档不应进入 tarball。公开 `.d.ts` 本身会暴露必要类型结构。

`release:publish` 先要求干净工作区及已处理完的 changesets，再执行同样的产物验收。随后用 Changesets 3 的 `publish-plan` 查询官方 registry，取得尚未发布版本和依赖顺序，将计划严格匹配到已验收包的名称、版本与 tarball。上传器按依赖顺序逐包重新核对 SHA-256，然后直接执行 `npm publish <tarball> --auth-type=web` 并继承终端，支持浏览器二次认证；不经过 Changesets 的非交互发布探测。上传阶段不重新打包、不执行生命周期脚本；首次失败立即停止，不自动重试未知结果。`.capix/release/verified.json` 记录本次验收包及其摘要，属于本地验证产物，不进入 npm 包。

检查或打包不会发布 npm。发布前审阅实际打包列表，确认未包含密钥、私有路径或不应公开的文本。

## 本地发布

发布由维护者在本地终端完成。GitHub 只保留 CI 与自动版本 PR，不需要配置 npm GitHub token、trusted publisher 或发布 Environment。

1. 使用持有 `@weiliang0121` scope 的 npm 账户，确认本次 18 个准确包名及其发布权限。本地验证不能证明远端名称占用或发布权限。
2. 原 17 包的 `0.1.0` 首发已完成。当前待发布 changesets 包含 ModelExchanges 固定起点、新 Tool、类型化领域事实、独立 Memory、领域／协议出口归位及 View 来源适配。它们包含破坏性公开契约修订，消费方不能只替换版本号。先按下节流程审阅并合并版本 PR；如手动准备版本，则执行 `pnpm release:version`，审阅并提交版本、CHANGELOG 与锁文件。核对 18 包 fixed 组的版本计划后，在干净的已审阅提交上完成上述验证。不要直接重发已有 `0.1.0`；`release:publish` 会拒绝尚未处理的 changesets。
3. 在自己的终端执行 `npm login --registry=https://registry.npmjs.org`，按 npm 要求完成浏览器登录和 2FA。不要把登录信息、OTP 或 token 写入仓库或聊天；发布时按终端提示完成认证。
4. 执行 `pnpm release:publish`，上传当前尚未存在的版本。此命令会写入 npm，只有决定正式发布时才执行。

多包发布不是原子事务。失败后先核对 registry 中每个准确版本，再从同一已审阅提交补齐未发布包。npm 可能先确认受理，再延迟开放公开查询；已收到成功回执时应等待生效，不能因短暂 404 认定未上传并立即补发。npm 每个准确版本只能发布一次；脚本只上传尚未发布且通过本次产物验收的版本。当前流程不创建或推送版本 tag，也不创建 GitHub Release。

登录成功不等于完成发布认证。发布时需保持交互终端，并在 npm 打开的网页完成验证；网页若提供短期免重复验证选项，可按需启用。Changesets 3.0.3 仅把 `EOTP` 识别为交互重试条件，非交互请求返回 `E403` 时不会进入浏览器流程；因此本仓库只用它生成发布计划，上传直接交给 npm。不要把验证码或 token 传入聊天或写进仓库。

## GitHub 设置与后续发布

- 在仓库 Actions 设置中允许 GitHub Actions 创建 PR。`version.yml` 使用仓库内置的 `GITHUB_TOKEN`，只授予 `contents: write` 和 `pull-requests: write`，无需长期 PAT。
- CI 对 main 的 push、PR 及手动运行执行全仓检查和发布包验证，不具有发布权限。Actions 以完整提交 SHA 固定版本；升级需单独审阅。
- 修改需要发布的行为或公开契约后，作者运行 `pnpm changeset`，选择实际修改的包和 bump 类型，说明用户可观察到的变化。Changeset 随代码合并到 main 后，`Version packages` 自动创建或更新版本 PR，执行 `pnpm release:version`，更新版本、CHANGELOG 与锁文件。当前使用 `changesets/action/version` v2.1.2 配合 CLI v3.0.3。
- 内置 `GITHUB_TOKEN` 创建或更新版本 PR 时，`opened`、`synchronize`、`reopened` 对应的 PR CI 运行需要批准。维护者可使用 **Approve workflows to run** 批准，或在 Actions 手动运行 `CI` 并选择版本 PR 分支，核对该分支当前提交的结果。参见 [GitHub 工作流触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。
- 人工审阅并合并版本 PR 后，在本地拉取 main 的已审阅提交并发布。合并本身不会发布 npm。

```sh
git switch main
git pull --ff-only
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm check
pnpm release:check
pnpm release:publish
```

执行前确认工作区干净，拉取后核对准备发布的提交。`release:publish` 会再次执行产物验收；npm 登录和 2FA 仍由维护者在终端完成。

## 候选分发

`pnpm integration:pack` 干净构建 18 个公开包，生成 `.capix/integration` tarball 批次，不发布 npm。manifest 记录源码提交、dirty 状态、源文件摘要和每个产物的 SHA256；文件白名单仅含编译产物、声明、README 与许可。

`pnpm integration:check` 在仓库外临时消费者中安装这批包，核对依赖、公开出口、运行结果和类型。消费方若要接入候选，须按准确 manifest 校验完整批次并维护自己的锁文件，不能混用不同源码批次的同版本包，也不能绕过公开出口读取私有 src/dist。

候选包和压缩发布包分别生成、分别验证，源码版本相同不意味着 tarball 字节相同。消费方的业务策略、持久 codec 和恢复资格需要自行适配；框架分发验证不替任意应用保证其升级完成。
