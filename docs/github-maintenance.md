# GitHub 维护

本页说明 CAPiX 的单维护者协作流程。贡献者报告问题或提交 PR，维护者负责范围判断、人工审阅与最终合并。仓库设置与工作流是不同层次的配置：工作流随 Git 版本维护，分支保护、Actions 权限和可见性需要在 GitHub 单独设置并核验。

## Issue 与贡献入口

缺陷报告提供准确包／版本或提交、环境、最小复现、预期与实际结果。能力建议描述具体使用场景、当前边界为何不足、期望行为、替代方案和验证方式。两个模板分别标记 `bug` 和 `enhancement`，保留空白 issue 供使用问题和文档反馈等用途。提交前搜索已有 issue，避免重复报告。

维护者先确认复现与范围，再决定是否进入实现：

- 缺少关键材料时，用 `question` 标记并说明需要补充的复现信息；文档问题使用 `documentation`。
- 能力或契约调整先在 issue 中收敛问题、边界和验收方式；小修复可以直接提交 PR，无须先建 issue。
- 有关联修复时，PR 使用 `Closes #编号`，合并后关闭对应 issue。重复或暂不采纳的建议说明原因，不用长期悬置代替决定。

文档入口使用 [GitHub 中的公开契约](https://github.com/weiliang0121/capix/blob/main/docs/README.md)和[贡献说明](https://github.com/weiliang0121/capix/blob/main/CONTRIBUTING.md)，不把尚未部署的文档站作为唯一入口。建议、讨论和历史候选不自动成为公开 API 或交付承诺。

安全问题先阅读 [SECURITY.md](https://github.com/weiliang0121/capix/blob/main/SECURITY.md)。不在 issue、PR、Actions 日志或附件中公开漏洞细节、利用步骤、密钥或真实用户数据；私下入口是否可用以该文件及实际界面为准。

## 工作分支到 main

1. 从最新 main 建立工作分支，聚焦一个可审查的行为闭环。Codex 使用 `codex/` 前缀，其他工作分支用简短名称说明目的；外部贡献者可从 fork 提交。
2. 先运行相关包测试，更新必要的公开契约与示例，再执行 `pnpm check`。分发变更按顺序执行 `pnpm release:check`、`pnpm integration:check`，不并发重建同一 dist。普通测试离线，不调用真实模型。
3. 提交 PR，说明问题、行为变化、设计选择、实际验证与限制，并给出 changeset 判断。公开行为、契约和分发物变化通常需要 changeset；仅贡献说明、模板或不影响发布物的仓库整理通常不需要。
4. 维护者人工阅读 diff、测试与讨论。让分支跟上 main，确认最新提交的 CI 通过并解决所有讨论后，以 squash 合并。
5. 合并后 GitHub 自动删除仓库内已合并的工作分支；main 的 push 再次执行 CI。GitHub 不自动发布 npm，Pages 也不随普通合并部署。

单维护者无法批准自己创建的 PR，因此不以他人的批准票数作为合并门槛。人工审阅仍然必需；绿色 CI 不替代契约判断。默认不启用机器人自动合并，也不引入自动修复、自动发版或新的调度平台。

## main 分支保护

2026-11-13 已在 GitHub 配置并读回核验：仓库公开，默认分支为 main，采用以下保护。后续更改仍需单独核验远端，不会仅因修改本文生效：

| 项目       | 当前配置                                                            |
| ---------- | ------------------------------------------------------------------- |
| 写入 main  | 必须经 PR 合并，保护规则适用于维护者；不允许直接推送绕过            |
| 状态检查   | 要求 GitHub Actions 的 `check` 成功，对应 `CI` 工作流中的 check job |
| 分支新鲜度 | 要求 PR 分支跟上 main；更新分支后重新核对最新提交检查               |
| 讨论       | 合并前解决所有 review conversation                                  |
| 批准票数   | 0，不要求他人的批准；仍由维护者人工审阅                             |
| 合并方式   | 仅启用 squash，关闭自动合并；合并后自动删除工作分支                 |
| main 历史  | 要求线性历史，禁止强制推送和删除分支                                |

当前 `check` 已绑定 GitHub Actions 来源，main 保护对管理员同样生效；不要求 Code Owner 或最后一次推送由他人批准。远端规则和 Actions 页面显示的实际结果是当前状态，不能只依赖任意同名状态。新增、重命名或拆分 CI job 时，同时核对 required checks，避免永久等待已不存在的检查。

## CI 与外部贡献权限

[CI 工作流](https://github.com/weiliang0121/capix/blob/main/.github/workflows/ci.yml)对面向 main 的 PR、main 的 push 和手动触发执行检查，依次运行 `pnpm check`、`pnpm release:check` 和 `pnpm integration:check`。CI 的 `GITHUB_TOKEN` 仅有 `contents: read`，checkout 不保留凭证。依赖安装和 registry 验证可能联网，普通回归不使用真实模型。

当前 fork workflow 审批策略为所有外部贡献者均需批准（`all_external_contributors`）。fork 的 PR 运行不得取得写权限或仓库 secrets，不为了让外部贡献通过 CI 而放开发送 token 的限制。不使用 `pull_request_target` 检出并执行贡献者代码。需要人工批准的 workflow，应先审阅工作流和脚本的变化，再批准执行；批准运行不代表批准合并。检查失败时修复可复现问题，不通过降低保护、忽略失败或注入私人运行环境取得绿色结果。

Actions 的默认 workflow 权限保持只读；[版本工作流](https://github.com/weiliang0121/capix/blob/main/.github/workflows/version.yml)在自己的 job 内明确请求创建版本分支与 PR 所需的 `contents: write` 和 `pull-requests: write`。仓库 Actions 设置需要允许 GitHub Actions 创建 PR，无需长期 PAT，也不在 CI 配置 npm 凭证。

## Changesets 版本 PR

changeset 随功能或修复 PR 合并后，`Version packages` 读取发布计划，必要时创建或更新专用版本 PR。该 PR 更新 18 包 fixed 组的版本、CHANGELOG 与锁文件；维护者核对实际包清单、bump 与变更说明，再走相同审阅和 squash 合并流程。

版本 PR 只进行版本整理；合并不会发布 npm。待发布 API 的实际内容以该 PR、公开契约和验证结果为准，不从版本号推导兼容性。版本 PR 消耗已有 changesets，自身不再为相同版本变更加一个 changeset。

内置 `GITHUB_TOKEN` 创建或更新版本 PR 时，相关 PR CI 可能处于待批准状态。维护者核对版本 PR 最新提交后，在 GitHub 使用 **Approve workflows to run**；若选择手动运行 `CI`，必须选择版本 PR 的分支，并确认结果属于要合并的准确提交。未触发、待批准或旧提交的绿色结果都不等于最新 PR 已满足保护。参见 [GitHub 工作流触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。

npm 发布需要维护者另行明确授权，在干净、已审阅的本地提交上完成身份认证和产物验收，再执行发布命令；版本 PR 的创建或合并不包含这项授权。准确命令、部分发布与未知结果处理见 [npm 发布](npm-publishing.md)。不自动建立 GitHub Release 或推送版本 tag。

## Pages 与设置核验

[文档部署工作流](https://github.com/weiliang0121/capix/blob/main/.github/workflows/docs.yml)仅允许手动触发，从 main 构建并通过 GitHub Pages 部署；普通 PR 和 push 不部署。Pages 需要独立配置 GitHub Actions 来源，实际部署成功后才能把站点地址视为可用。仓库公开也不会自行证明 Pages 已上线。

维护者调整可见性或保护后，应分别核对仓库可见性、main 默认分支、PR／检查／讨论门槛、强推与删除限制、自动合并状态、Actions 最小权限及创建 PR 开关。记录实际核验结果，不把配置目标当作已完成；不要为通过检查临时关闭保护。公开仓库、合并 PR、发布 npm 和部署 Pages 分别判断与授权。
