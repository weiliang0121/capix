# npm 发布

CAPiX 采用 MIT。发布包包含编译后的 ESM JavaScript、类型声明、README 和 LICENSE；源码仓库仍可保持私有。MIT 允许接收者使用、修改和再分发，保留相应版权及许可声明。压缩与去注释用于减少分发体积，不能保护 JavaScript 实现不被阅读。

## 范围与版本

当前公开范围只有 `contracts`、`protocol` 和 `server/*`，共 17 个包。根包、`services/*`、`client/*` 和 `apps/*` 保持 `private: true`。所有公开包属于同一个 Changesets fixed 组，任何包的发布变更都会推进整个组到相同版本；依赖仍用 `workspace:*`，打包时转换成准确发布版本。

已确认 `@capix` scope 无法注册；当前包名仅是仓库内占位，不能据此正式发布。用户正在选择全新品牌，名称和可用 scope 尚未确定，本轮未执行改名。确定后须统一修改包名、import、workspace 依赖、Changesets fixed 名单、消费者示例和发布脚本中的名称，并重新验证。首次发布还必须取得该 scope 的维护权限。不要从其他项目取得 npm 凭证。

## 本地验证

使用仓库声明的 Node 22.23.2 和 pnpm 10.7.1，依赖通过官方 registry 安装：

```sh
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm check
pnpm release:check
```

`release:build` 为公开包清理并重建发布产物，移除内部注释并压缩 JavaScript；不进行跨包 bundle，不混合依赖实体身份。`release:check` 构建并检查实际 tarball，验证包白名单、入口、内部依赖和仓库外消费者安装。原始 `.ts`、实现 source map、声明 map、测试、服务和内部文档不应进入 tarball。公开 `.d.ts` 本身会暴露必要类型结构。

`release:publish` 先要求干净工作区及已处理完的 changesets，再执行同样的产物验收。随后用 Changesets 3 的 `publish-plan` 查询官方 registry，取得尚未发布版本和依赖顺序，将计划严格匹配到已验收包的名称、版本与 tarball，并由仓库脚本重新核对 SHA-256，最后通过 `publish --from-pack-dir` 上传这批文件。上传阶段不重新打包；CLI 自身不会核验计划中的 integrity，摘要验证由仓库脚本承担。`.capix/release/verified.json` 记录本次验收包及其摘要，属于本地验证产物，不进入 npm 包。

检查或打包不会发布 npm。发布前审阅实际打包列表，确认未包含密钥、私有路径或不应公开的文本。

## 第一次发布与 npm 设置

新包不能仅凭 GitHub OIDC 创建完整信任关系：先手动发布一次，才能在 npm 包设置中登记 trusted publisher。官方 Changesets 指南也采用这种 bootstrap 方式，参见 [首次发布](https://changesets.dev/guide/versioning-and-publishing#publishing-for-the-first-time)。

1. 确定可用的新品牌与 scope，完成统一改名，并确认 npm 账户或组织具有该 scope 下全部 17 个包的发布权限。当前占位的 `@capix` 无法注册，尚不能进入正式首发。
2. 在干净的、已审阅提交上完成上述验证。当前初始版本是 `0.1.0`；bootstrap 可直接发布这批真实包，不创建占位包，也不先运行 `release:version` 把版本推进一轮。
3. 由维护者在自己的终端执行 `npm login --registry=https://registry.npmjs.org`，按 npm 要求完成浏览器登录和 2FA。不要把登录信息、OTP 或 token 写入仓库或聊天。
4. 执行 `pnpm release:publish` 发布当前尚未存在的版本。此命令会写入 npm，只有决定正式首发时才执行；多包发布不是原子事务，失败后先核对 registry 中每个准确版本，再对同一已验证提交补齐未发布包。
5. 对每个 npm 包单独设置 trusted publisher：GitHub owner、repository 必须准确匹配实际私有仓库；workflow filename 填 `publish.yml`；environment 填 `npm`；显式允许直接 `npm publish`。当前流程不用 `npm stage publish`。
6. 当前 npm 要求新配置在两天内首次成功发布，否则配置过期，需删除重建。可在准备下次发布时设置这些 publisher，避免 bootstrap 后长期闲置导致失效。确认 OIDC 正常后，可按 npm 设置限制传统 token 发布。

当前 npm trusted publishing 要求 npm CLI ≥11.5.1、Node ≥22.14.0，并支持 GitHub 托管 runner；workflow 使用固定 npm 11.6.2。仓库使用的 pnpm 10.7.1 本身会把实际上传委托给 npm：Changesets 3.0.3 → `pnpm publish` → `runNpm`。workflow 显式设置 `npm_config_npm_path` 到升级后的 npm 可执行文件，因此认证落到支持 OIDC 的 npm，而非假设升级全局 npm 就能改变所有包管理器的行为。依据：[Changesets pnpm 适配](https://github.com/changesets/changesets/blob/%40changesets%2Fcli%403.0.3/packages/cli/src/lib/pnpm.ts)、[pnpm 10.7.1 发布实现](https://github.com/pnpm/pnpm/blob/v10.7.1/releasing/plugin-commands-publishing/src/publish.ts)、[npm 官方设置与限制](https://docs.npmjs.com/trusted-publishers/)。

私有 GitHub 仓库可使用 OIDC，但不生成 npm provenance。workflow 显式设置 `NPM_CONFIG_PROVENANCE=false`，不尝试公开源码或开启来源证明。将来若公开仓库，需要独立决定是否启用 provenance。[npm provenance 条件](https://docs.npmjs.com/trusted-publishers/#automatic-provenance-generation)

## GitHub 设置与日常发布

- 在仓库 Actions 设置中允许 GitHub Actions 创建 PR。`version.yml` 使用仓库内置的 `GITHUB_TOKEN`，只授予 `contents: write` 和 `pull-requests: write`。不配置长期 PAT。
- 创建名为 `npm` 的 GitHub Environment，并限制到 main；若当前 GitHub 计划支持，可添加 required reviewers。npm publisher 的 environment 必须与工作流完全一致。手动启动工作流仍会受已有环境保护规则约束。
- CI 对 main 的 push、PR 及手动运行执行全仓检查和发布包验证，不具有发布权限。Actions 以完整提交 SHA 固定到已核实的正式版本；版本升级需单独审阅。
- `Version packages` 在 main 收到 changeset 后创建版本 PR，执行 `pnpm release:version`，刷新版本、CHANGELOG 与锁文件。它没有 npm token、OIDC 权限或 publish 步骤。当前使用 `changesets/action/version` v2.1.2 配合 CLI v3.0.3，不能直接替换成仅兼容 CLI v2 的 action v1。
- 内置 `GITHUB_TOKEN` 创建或更新 PR 不会触发常规 PR CI。维护者须从 Actions 手动运行 `CI`，选择版本 PR 的分支，并检查该分支当前提交的结果；也可以在本地完成同样验证。若需要全自动触发，应独立配置 GitHub App，不默认引入 PAT。参见 [GitHub 的工作流触发限制](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow)。
- 审阅版本 PR 并合并后，选择 main 手动启动 `Publish packages`，输入准备发布的完整 40 位提交 SHA。工作流核对其与本次 main 运行提交一致，再从该提交重新安装、检查和打包。非 main 运行会跳过发布。后续 main 推进不会替换本次已经选定的提交。
- 发布 job 只有 `contents: read` 与 `id-token: write`，使用 GitHub 托管 `ubuntu-24.04` 和 `npm` 环境，通过 OIDC 发布。无需 `NPM_TOKEN`、`NODE_AUTH_TOKEN` 或 `registry-url` 的 token 配置。发布构建不复用依赖缓存。
- Changesets 可能创建本地版本 tags；当前工作流不推送 tag、不创建 GitHub Release。npm 每个准确版本只能发布一次；若部分包已经成功，重跑前核对版本和日志，保持同一已审阅提交及产物。

目前仅提供配置和本地验证流程；scope、npm 维护权限、首发、每包 trusted publisher、GitHub 环境保护和真实 OIDC 发布需要维护者在相应服务落实，不能由离线检查证明。
