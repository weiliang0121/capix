# Changesets

CAPiX 公开包统一位于 `packages/`，使用 `@weiliang0121/capix-*` 命名；18 个包独立发版，准确清单见 [发布清单](../scripts/release/packages.mjs)，[配置](config.json) 不设置 fixed 或 linked 版本组。客户端、参考装配和具体应用不属于框架发布清单。

修改需要发布的行为或公开契约后，在仓库根运行 `pnpm changeset`，选择实际修改的包及 bump 类型，说明用户可观察到的变化。Changesets 按变更与必要依赖更新生成独立版本计划，不要求所有包共同升号。各包 CHANGELOG 维护自身依赖兼容性与迁移要求；package.json 与实际 tarball 仍须准确声明机器使用的依赖版本。只改开发文档或测试时无需创建 changeset。

main 上的 Version packages 工作流只生成或更新版本 PR；人工审阅并合并后，由维护者在本地拉取 main（`git pull --ff-only`），安装依赖、验证并运行 `pnpm release:publish`。合并不会发布 npm。

发布前先消费待发布 changesets，审阅本次版本、CHANGELOG 与锁文件，不覆盖 registry 已有的准确版本。0.x 的破坏性契约修订使用 minor 并写明消费方迁移要求。完整分发检查覆盖 18 包，不等于本次上传 18 包。npm 登录与 2FA 在维护者终端完成；GitHub 无需配置 npm token、trusted publisher 或发布 Environment。

本地发布和验证步骤见 [npm 发布说明](../docs/npm-publishing.md)。
