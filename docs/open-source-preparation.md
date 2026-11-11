# 包命名与开源准备

后续归属说明：本文保留当轮盘点、包数和验证事实。Observer 内容组合（ActiveView、ConversationContent、同步及测试）现已整体迁至 `capix-lab/services/observer-content`，不再是 CAPiX 包；尚未成为通用公开预设。当前 CAPiX 为 18 个公开包加 2 个私有客户端包，候选分发共 20 包，见 [当前包边界](organization.md) 与 [分发规则](npm-publishing.md)。

状态：第一版已实施；本文保留目标设计及原盘点，实际完成范围、过渡项和验证见 [拆库实施记录](repository-split-implementation.md)。未创建远端、发布新包或改变可见性。

品牌继续使用 **CAPiX**，公开包继续使用 **`@weiliang0121/capix-<职责>`**。17 个 `0.1.0` 包的发布与验收记录见 [npm 发布](npm-publishing.md)；本轮没有重新查询 registry。本文补充 [仓库拆分设计](repository-split-design.md)，不取代当前 [项目组织](organization.md) 和模块契约。

## 1. 命名先区分三个问题

| 问题                             | 由哪里表达                                  | 示例                                          |
| -------------------------------- | ------------------------------------------- | --------------------------------------------- |
| 使用者安装和导入什么能力？       | npm 包名和公开出口                          | `capix-resources`、`capix-runtime`            |
| 维护者在哪里找到这个包？         | 源码目录                                    | 候选 `packages/resources`、`packages/runtime` |
| 它在哪个环境运行、承担哪种角色？ | README 支持范围、依赖与契约；必要时加入名称 | Node 执行、远端消费、HTTP 适配、React 展示    |

`server` 不是现有 15 个包共同的业务职责。资源、调用、交互、实体和 Runner 可以在 Node CLI、测试或内嵌宿主中工作，并不一定启动服务器。建议在长期目录中去掉这个统一分类，但保留真实的 Node 平台要求。

`client` 则可能是准确的协作角色：当前客户端接受远端提交反馈、同步消息与观测，和执行 Scene 的 Runtime 不同。不能因为消除 `server/` 就机械地消除 `client` 一词，也不能把它替换成未经验证的 `browser` 支持承诺。

## 2. 推荐统一平铺 packages，现有发布名称不变

| 布局方案                                         | 优点                           | 代价／问题                                                 |
| ------------------------------------------------ | ------------------------------ | ---------------------------------------------------------- |
| 保留 `contracts/protocol/server/client`          | 当前迁移成本最低               | 一级目录混合了协议、运行角色和平台；适合作为过渡布局       |
| `packages/core/entities/presets/integrations/ui` | 分类直观                       | 分类轴交叉；预设、集成和 UI 可能组合，容易为了目录争论归属 |
| **`packages/<独立包>`**                          | 位置直接对应包，便于查找和分发 | 分类导航需要由文档承担；移动时仍需处理构建与测试路径       |

推荐第三种。包列表、依赖图和使用路径可以分组展示，不把这些阅读分类固化成额外的源码层级。完整目标目录见 [拆库设计 §2](repository-split-design.md#2-capix-的目标目录)。

### 2.1 现有公开包

以下只是目录目标；17 个 npm 名称、scope 和公开入口保持不变。

| 当前路径                  | 目标路径                    | npm 名称                              |
| ------------------------- | --------------------------- | ------------------------------------- |
| `contracts/`              | `packages/contracts/`       | `@weiliang0121/capix-contracts`       |
| `protocol/`               | `packages/protocol/`        | `@weiliang0121/capix-protocol`        |
| `server/resources/`       | `packages/resources/`       | `@weiliang0121/capix-resources`       |
| `server/structure/`       | `packages/structure/`       | `@weiliang0121/capix-structure`       |
| `server/invocation/`      | `packages/invocation/`      | `@weiliang0121/capix-invocation`      |
| `server/checkpoint/`      | `packages/checkpoint/`      | `@weiliang0121/capix-checkpoint`      |
| `server/runtime/`         | `packages/runtime/`         | `@weiliang0121/capix-runtime`         |
| `server/interaction/`     | `packages/interaction/`     | `@weiliang0121/capix-interaction`     |
| `server/transcript/`      | `packages/transcript/`      | `@weiliang0121/capix-transcript`      |
| `server/memory/`          | `packages/memory/`          | `@weiliang0121/capix-memory`          |
| `server/view/`            | `packages/view/`            | `@weiliang0121/capix-view`            |
| `server/measurement/`     | `packages/measurement/`     | `@weiliang0121/capix-measurement`     |
| `server/records/`         | `packages/records/`         | `@weiliang0121/capix-records`         |
| `server/changes/`         | `packages/changes/`         | `@weiliang0121/capix-changes`         |
| `server/diagnostics/`     | `packages/diagnostics/`     | `@weiliang0121/capix-diagnostics`     |
| `server/model-provider/`  | `packages/model-provider/`  | `@weiliang0121/capix-model-provider`  |
| `server/model-exchanges/` | `packages/model-exchanges/` | `@weiliang0121/capix-model-exchanges` |

`runtime` 继续表示绑定、装配及 Runner；不改成 `server-runtime`，也不新增一个转发所有包的 `core` 门面。统一目录不改变现有依赖方向。

### 2.2 客户端、预设、集成和 UI

| 能力                        | 建议目标目录／名称后缀 | 状态与理由                                                                        |
| --------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| 客户端消费生命周期          | `client-runtime`       | 保留现有职责名；目前是私有 `@capix/client-runtime`，不在本轮发布                  |
| 上述客户端的 HTTP 适配      | `client-http`          | 与 `client-runtime` 成对；目前是私有 `@capix/client-http`，不表示通用 HTTP 请求库 |
| 工具循环预设                | `tool-loop`            | 候选；普通 Group 组合，先拆开服务内提示、归档及材料依赖                           |
| Observer 内容组合／默认策略 | `observer-content`     | 现有私有包的职责名；不改成暗示通用内核实体的 `content`                            |
| SQLite Checkpoint 实现      | `sqlite-checkpoint`    | 候选；先形成独立 Store 适配，不能直接发布混合业务表的服务 Store                   |
| React 观测组件              | `react-observer`       | 候选；仅表示可嵌入组件与投影，不是整个 `apps/observer`                            |

新增公开名称沿用 [发布命名规则](npm-publishing.md)：必要限定词在主体之前，例如 `sqlite-checkpoint`、`react-observer`。`client-runtime` 是客户端的运行与消费生命周期，`client-http` 是其 HTTP 适配；不为追求词序对称再改既有 `model-provider` 等清晰的职责名。候选名称不代表已经创建、批准发布或加入 17 包 fixed 组。

现阶段不将客户端直接缩成 `capix-client`：其 [公开传输契约](../packages/client-runtime/src/transport.ts) 包含具体 Conversation 与 Observer 类型，不是任意 Agent 服务的统一客户端。也不急着拆成 `conversation-client`：现有 ObservationReplica 等能力需要先明确归属。目录可以先收敛，抽象范围仍按实际实现说明。

参考宿主迁出后，实验仓库继续使用 `services/conversation`、`apps/observer` 等名称没有矛盾：那里确实存在服务进程和应用入口。这些名称不进入框架包名，也不需要伪装成可发布产品。

### 2.3 平台说明独立维护

去掉 `server/` 只改变组织方式。当前实现真实使用 Node 能力，例如 Invocation 的 `AsyncLocalStorage`、资源与结构中的 `node:crypto`；model-provider 使用 `fetch` 也仍有 Node 依赖。不能据此宣称执行内核可在浏览器、Edge 或其他运行时工作。

后续每个包 README 应分别写清：提供什么、依赖哪些端口、已经验证的运行环境，以及一个最小用法。客户端可以说明其 Web API 需求，但额外平台兼容性需要实际验证。纯类型、纯值协议与具体执行实现分别判断，不做全仓“跨平台”承诺。

## 3. 当前已经具备什么，还缺什么

本轮读取了根 README、发布文档与脚本、workspace、两份 Actions workflow、客户端出口及代表性包实现。以下是内容盘点，不是完整开源审计。

| 项目      | 当前证据                                             | 下一步                                                                            |
| --------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| 许可证    | 根及 17 个发布包已有 MIT LICENSE                     | 保持 MIT；核对第三方代码与素材原有许可／署名，如现有 UI LICENSE，不覆盖其来源说明 |
| 分发      | 17 包 `0.1.0` 发布与独立消费者验收已有记录           | 已发布包保持身份；新增包另定公开范围                                              |
| 版本与 CI | Changesets、固定版本组、锁文件、CI 与版本 PR 已配置  | 延续本地 npm 发布，不为开源另建发布平台                                           |
| 当前契约  | 资源、结构、调用、稳定事实、CP、交互等已有专题文档   | 保持当前契约与历史候选的明确区分                                                  |
| 首次使用  | 已有公开包字典例子及离线对话 demo                    | README 前置安装后能直接运行的公开例子                                             |
| 贡献入口  | 未见 CONTRIBUTING、SECURITY 或 issue／PR 模板        | 优先补贡献说明和有效的漏洞报告途径；模板按实际需要补                              |
| 公开范围  | 当前没有本轮完整跟踪文件／历史／Actions 内容审查结果 | 单独验收，不把 `.gitignore` 或 CI 通过当成无敏感内容证明                          |

当前 GitHub workflow 是 CI 加自动版本 PR；不是自动发布 npm。`release:check` 会重建打包产物，并在临时消费者中安装包，可能访问 registry；它不发布 npm，也不调用真实模型。普通回归不使用真实模型，与包安装是否需要联网是两个问题。

### 3.1 README 优先回答陌生使用者的问题

建议顺序如下，不要求先完成目录迁移：

1. 一段定位：CAPiX 通过结构、资源与运行器组织 Agent 处理；强调可组合的能力及明确的调用边界。
2. Node／包管理器要求、公开包安装命令、一个完整离线例子与预期输出。
3. Scene、Resources、Runner 和可选 Interactions 的最短解释；再链接细分包。
4. 如何在仓库中运行参考对话，以及如何选择真实模型；将参考服务与 npm 能力区分。
5. 当前契约／限制、贡献入口、MIT 许可与文档导航。

直接复用 [字典结构](../examples/dictionary.mjs) 与 [运行入口](../examples/runner.mjs)：三个公开包即可展示资源登记、节点、场景和运行。当前根 README 的首个例子先导入私有 `@capix/observer-service/assembly`，适合移到参考装配章节。原仓库更名、相邻探索目录和“本轮迁移”等历史说明移到组织文档，不占首次上手入口。

示例验证应分两条：仓库外只安装公开包运行字典；新检出构建后运行 `pnpm conversation --demo`。后者验证参考装配，不是前者的依赖。具体命令随真正的 README 改写一起执行，本轮未重新运行。

### 3.2 开放协作最少需要的说明

- **CONTRIBUTING.md**：准确工具链、安装与离线检查、跨包公开出口、Changeset 何时需要、架构提案与普通修复如何评审。AGENTS.md 继续服务代码协作，但不能替代人的贡献入口。
- **SECURITY.md**：支持的版本范围、实际可用的私下报告方式，以及资源访问控制不等于操作系统沙箱等现有边界。不编造联系邮箱或响应时限。GitHub 为公开仓库提供可配置的私密漏洞报告入口，启用后再写成可用路径。[GitHub 私密漏洞报告配置](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
- **版本与支持说明**：标明当前为 0.x；格式或公开契约变化要记录版本依据。当前不维护旧数据库／旧 CP 自动迁移，不让“公开源码”被误读成已有任意历史兼容承诺。

问题／PR 模板可以只收集版本、最小复现和验证结果；行为准则与支持文档按实际协作需要补，不以一次建立完整治理目录作为开源门槛。正式贡献流程由维护者确认后再落地。

## 4. 能力清单按实现状态写

公开导航应标注“已发布能力”“仓库内参考实现”“设计候选”，不把实验曾验证过等同于公开产品保证。例如：

| 能力                                         | 本轮应使用的表述                                                 |
| -------------------------------------------- | ---------------------------------------------------------------- |
| Scene／Group／Node、资源、调用、有限 CP 恢复 | 已有公开包与当前契约                                             |
| 原生模型协议、模型交换实体                   | 已有公开包；具体协议支持范围看 model-provider 文档               |
| ToolLoop 与工具对话宿主                      | 当前位于参考服务，不是已独立发布的预设包                         |
| Conversation／Observer 客户端与页面          | 当前私有 workspace／参考应用                                     |
| MCP                                          | 相关设计已讨论；当前文档仍将其列在首版范围之外，不写成已实现接入 |
| 操作系统沙箱、全天候调度等                   | 不因资源机制可组合就宣称已有对应实现                             |

测试或演示的结论带上适用范围：一个参考服务的性能、恢复与模型质量不自动成为任意装配的保证。历史报告保留价值，同时给出当前契约入口。

## 5. 公开范围与历史单独验收

公开 npm 产物、公开 Git 源码、迁出实验仓库是三个独立动作。**删除或迁走当前文件，不会让仍可达的 Git 历史中的同一内容消失。** 如果直接将现有仓库改为 public，还需要审阅已有 Actions 运行信息；GitHub 明确说明 private 转 public 会使 Actions 历史与日志对所有人可见。[GitHub 仓库可见性说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)

建议对 CAPiX 自身做一次有范围的审阅：当前跟踪文件、拟保留公开的分支和 tag 所可达的历史、提交与讨论附件、Actions 日志及仍保留的制品。重点确认研究数据、真实对话、绝对环境路径、截图、配置与第三方材料是否适合公开。真实凭证如果出现，先撤销／更换，再决定清理方式；不在报告中复述秘密值。不读取外部业务仓库配置，也不把实验库中所有内容自动复制到新仓库。

GitHub 的 secret scanning 可以检查 Git 历史等内容，但它不能替代对业务材料、使用许可和公开意愿的人工判断；本轮未确认仓库该功能设置，也未完成历史扫描。[GitHub Secret scanning 范围](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning)

公开历史有两条路径：

| 路径                                 | 适用情况                                                 | 代价                                                                               |
| ------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 现有仓库直接公开，保留历史           | 审阅后历史均可公开                                       | 保留 blame、设计演进与提交关联；当前树迁出实验不会隐藏旧版本                       |
| 从审阅通过的源码快照建立新的公开历史 | 原历史含需继续保密的材料，或明确希望公开仓库从整理版起步 | 旧历史继续私有；需交接仓库地址、CI、包元数据和来源／署名信息，不能假装历史自然延续 |

默认先审阅，不自动重写历史、不 force push，也不自行选择新的公开仓库。此选择涉及真正的公开范围，留待审阅结果与用户决定；不是继续写设计文档的阻塞条件。

## 6. 逐步推进与验收

| 步骤          | 工作                                                                       | 可审查的完成结果                                           |
| ------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1. 公共入口   | 改写 README 首屏与快速开始，补 CONTRIBUTING、实际可用的 SECURITY 指引      | 仓库外运行公开包例子；新检出运行离线 demo；链接与命令正确  |
| 2. 公开内容   | 审阅 CAPiX 当前文件、拟公开历史及关联 Actions 日志／制品，确定公开历史路径 | 记录审阅范围、遗留项和处理决定；不输出秘密内容             |
| 3. 组织收敛   | 按拆库清单独立迁移包目录或实验；候选预设、适配和 UI 分别闭合               | 包身份不变，保留正式回归，跨仓依赖明确；每个变更可单独回退 |
| 4. 公开前验收 | frozen install、`pnpm check`、`pnpm release:check`，复核实际可见性变更范围 | 记录准确提交与验证结果；由用户决定修改 GitHub 可见性       |

步骤 3 是长期整理路线，不是公开源码必须全部完成的门槛。初次公开可以保留明确标注的参考服务和历史设计；若其中有不适合公开的材料，必须先处理对应公开范围。不要为了首轮开源先实现通用客户端、统一持久化、所有 UI 包或新的自动发布系统。

本轮建议后的第一个实施闭环是 **README 公共包起点 + 最小贡献说明 + 对应上手验证**。目录迁移、实验迁出和仓库可见性分别推进。这能先改善作者体验，同时保留已验证的包与运行契约。

## 7. 本轮验证范围

初稿阶段只进行了设计文档、源码依据和链接检查。随后用户授权落实两份方案；当前验证请读实施记录，初稿中的未实施状态不再描述当前目录。公开内容的审阅另见 [本地内容审阅](open-source-content-audit.md)，它不构成已完成全部公开验收的声明。
