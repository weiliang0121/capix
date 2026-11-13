# 文档站构建与发布

CAPiX 使用 VitePress 生成静态文档；GitHub Pages 工作流位于 [docs.yml](../.github/workflows/docs.yml)。目前仅支持从 `main` 手动发布，推送代码不会触发发布。

## 本地开发与预览

使用仓库规定的 Node 22.23.2 和 pnpm 10.7.1，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm docs:dev
```

构建并预览 GitHub 项目站的子路径：

```sh
CAPIX_DOCS_BASE=/capix/ pnpm docs:build
CAPIX_DOCS_BASE=/capix/ pnpm docs:preview
```

打开预览命令给出的地址并访问 `/capix/`。产物位于 `docs/.vitepress/dist`，不提交到 Git。子路径通过 `CAPIX_DOCS_BASE` 设置，遵循 [VitePress 的 base 配置](https://vitepress.dev/guide/deploy#setting-a-public-base-path)。

## 首次发布

以下步骤会公开发布静态站点，应在确认发布范围后执行：

1. 将已审查的工作流及文档提交到 GitHub 默认分支 `main`。
2. 在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 在 **Actions → Publish documentation → Run workflow** 选择 `main`，手动运行。
4. 构建和部署完成后，从运行记录的 `github-pages` environment 或 **Settings → Pages → Visit site** 打开网站。未配置自定义域名时，预期地址为 [weiliang0121.github.io/capix/](https://weiliang0121.github.io/capix/)。

工作流按顺序安装依赖、构建框架、构建文档，上传静态产物后由独立部署 job 发布；它从 Pages 配置读取实际 base path。构建 job 只有源码和 Pages 配置读取权限，部署 job 才有 `pages: write` 和 `id-token: write`。认证使用 GitHub 自动提供的 `GITHUB_TOKEN` 与 OIDC，无需 `NPM_TOKEN`，也不执行 npm 发布。参见 [GitHub 自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

仓库要求所有 Action 固定到完整 commit SHA，这也适用于复合 Action 的内部步骤。`upload-pages-artifact` v3 内部使用未固定的 `upload-artifact@v4`，因此工作流直接按 Pages 格式生成 `artifact.tar`，再由固定 SHA 的 `upload-artifact` 上传为 `github-pages` 产物。

[GitHub Pages 的套餐支持](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)区分仓库可见性：GitHub Free 支持公开仓库；私有仓库需要 Pro、Team 或 Enterprise 等支持套餐。私有源码仓库不会自动让站点私有；[普通 Pages 站点仍可公开访问](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。文档中的仓库源码链接仍指向 `main`，访问权限取决于仓库本身；公开站点不会授予私有源码访问权。

## 后续自动发布

确认需要在每次合入 `main` 后自动更新站点，再将以下 `push` 触发器加入工作流现有的 `on` 节点，保留 `workflow_dispatch`：

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
```

此后 `main` 推送会构建并发布。工作流的 `pages` 并发组会串行处理部署，不取消正在进行的发布；`github-pages` environment 的保护规则仍然生效。
