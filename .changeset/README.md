# Changesets

公开包使用同一 fixed 版本组：`contracts`、`protocol` 和 `server/*`，当前共 17 个包。私有 workspace 不发包、不创建版本 tag。

修改需要发布的行为或公开契约后，在仓库根运行 `pnpm changeset`，选择实际修改的包及 bump 类型，说明用户可观察到的变化。Changesets 会把整个 fixed 组推进到同一版本。只改开发文档或测试时无需创建 changeset。

main 上的 Version packages 工作流只生成版本 PR；合并不会发布 npm。正式发布由维护者在 main 手动启动 Publish packages 工作流。

首发、scope、OIDC 和验证步骤见 [npm 发布说明](../docs/npm-publishing.md)。
