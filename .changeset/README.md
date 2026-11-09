# Changesets

CAPiX 公开包使用 `@weiliang0121/capix-*` 命名（`server/runtime` 为 `@weiliang0121/capix-runtime`），使用同一 fixed 版本组：`contracts`、`protocol` 和 `server/*`，当前共 17 个包。六个私有客户端、服务及应用 workspace 保留现有 `@capix/*` 身份，不发包、不创建版本 tag。

修改需要发布的行为或公开契约后，在仓库根运行 `pnpm changeset`，选择实际修改的包及 bump 类型，说明用户可观察到的变化。Changesets 会把整个 fixed 组推进到同一版本。只改开发文档或测试时无需创建 changeset。

main 上的 Version packages 工作流只生成或更新版本 PR；人工审阅并合并后，由维护者在本地拉取 main（`git pull --ff-only`），安装依赖、验证并运行 `pnpm release:publish`。合并不会发布 npm。

首发直接使用当前 `0.1.0`，不额外 bump。npm 登录与 2FA 在维护者终端完成；GitHub 无需配置 npm token、trusted publisher 或发布 Environment。

本地发布和验证步骤见 [npm 发布说明](../docs/npm-publishing.md)。
