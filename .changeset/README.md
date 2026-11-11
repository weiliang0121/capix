# Changesets

CAPiX 公开包统一位于 `packages/`，使用 `@weiliang0121/capix-*` 命名；18 个包组成同一 fixed 版本组，准确清单见 [config.json](config.json)。其中此前 17 包已发布 `0.1.0`，新增 Tool 尚未发布。客户端、参考装配和应用由独立 Lab 仓库维护，不属于框架 workspace 或发布清单。

修改需要发布的行为或公开契约后，在仓库根运行 `pnpm changeset`，选择实际修改的包及 bump 类型，说明用户可观察到的变化。Changesets 会把整个 fixed 组推进到同一版本。只改开发文档或测试时无需创建 changeset。

main 上的 Version packages 工作流只生成或更新版本 PR；人工审阅并合并后，由维护者在本地拉取 main（`git pull --ff-only`），安装依赖、验证并运行 `pnpm release:publish`。合并不会发布 npm。

首发已完成。后续先消费待发布 changesets，审阅版本、CHANGELOG 与锁文件，不覆盖已有 `0.1.0`。0.x 的破坏性契约修订使用 minor 并写明消费方迁移要求。npm 登录与 2FA 在维护者终端完成；GitHub 无需配置 npm token、trusted publisher 或发布 Environment。

本地发布和验证步骤见 [npm 发布说明](../docs/npm-publishing.md)。
