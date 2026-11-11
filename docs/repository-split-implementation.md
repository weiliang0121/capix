# 仓库拆分第一版实施记录

后续归属说明：本文保留当轮盘点、包数和验证事实。Observer 内容组合（ActiveView、ConversationContent、同步及测试）现已整体迁至 `capix-lab/services/observer-content`，不再是 CAPiX 包；尚未成为通用公开预设。两个私有客户端及其测试也已交接至 `capix-lab/packages`；当前 CAPiX 为 18 个公开框架包，候选分发共 18 包，见 [当前包边界](organization.md) 与 [分发规则](npm-publishing.md)。

日期：2026-11-10。依据：[拆库设计](repository-split-design.md)、[包命名与开源准备](open-source-preparation.md)。来源基线：`ff9bce492c183625851610f838b31189d44cd90f`。

后续边界更新：用户已确定 CAPiX 独立自证、测试跟随包，Lab 是实验与参考装配仓。本文保留初次交接的文件位置与验证事实；其中要求框架改动执行 Lab 验收的工作安排不再适用。当前设计见 [包内测试与框架自证](testing-organization-design.md)，目录与脚本迁移已实施，见[测试迁移记录](testing-migration.md)。

本轮落实两份方案的本地第一版。没有创建远端仓库、推送、发布 npm、改写历史或修改 GitHub 可见性；以下改动仍供维护者审阅。

## 1. 实际布局

```text
capix/
├── packages/                   # 17 个既有公开包 + 3 个既有私有包
├── examples/                   # 字典、运行器、视图、记录与组合的最小用法
├── test/                       # 纯内核、客户端和内容预设正式回归
├── docs/                       # 当前契约、组织、分发与本次交接
├── scripts/release/            # 显式 17 包；本地 npm 发布
├── scripts/integration/        # 显式 20 包本地候选产物
├── CONTRIBUTING.md
├── SECURITY.md
└── pnpm-lock.yaml

capix-lab/                     # 新的独立本地 Git 仓库，尚无 remote
├── services/{conversation,observer}/
├── apps/observer/              # 暂保留一个 Vite 应用的两个页面入口
├── examples/                   # 完整场景、规模基准及历史研究
├── test/                       # 宿主、SQLite、HTTP/UI 与恢复集成回归
├── docs/                       # 服务契约、历史报告、迁移清单
├── scripts/import-candidates.mjs
├── vendor/candidates/          # 本地 tarball，忽略；来源 manifest 单独记录
└── pnpm-lock.yaml              # 独立锁文件
```

实验目录暂保留原名，避免同时改变全部场景入口；未来可按阅读需要归入 scenarios／studies／benchmarks。`capix-lab` 不是旧探索仓库或业务仓库，框架运行不会隐式读取它的配置。

公开包名、`0.1.0` 版本、exports 和 17 包 Changesets fixed 组保持不变。`client-runtime`、`client-http`、`observer-content` 迁入 packages，但仍保持 `@capix/*` 私有身份。源码移动不改变 Node 平台要求，不新增浏览器执行承诺。

## 2. 尚未成熟的能力如何处理

- ToolLoop 连同具体回答、材料、归档与恢复装配留在 Lab 的 Conversation 服务内，没有为了拆库提前创建公共工具平台。
- SQLite 实现仍归两个宿主；混合业务表与归档预算的 Store 没有被改名发布成通用适配。
- 客户端与内容预设作为现有独立包留 CAPiX，但不扩大到任意业务协议。
- UI 完整保留原应用、投影和双入口，第三方许可与来源注释一起交接；独立 React 观测组件是后续候选。

因此两个仓库已经分开，候选包的成熟工作仍可逐项推进；没有维护两套框架源码，也没有为了新目录建立空包。

## 3. 跨仓使用明确产物

CAPiX 的 `pnpm integration:pack` 构建全部 20 包，将编译 JS、声明与允许的文档打成同一批 tarball。只有完整批次核对成功后才替换上一次候选目录；发布范围仍由另一份 17 包清单控制。

manifest 同时记录 `baselineHead`、工作树 `dirty`、实际源文件摘要和逐包 SHA256。未提交工作树产生的包不能被描述为基线提交的原样产物。Lab 导入时重新验证批次与每个包，再用根 overrides 将传递依赖固定到相同产物。

```sh
# CAPiX
pnpm integration:pack

# 在 capix-lab，显式指定上一步产物目录
pnpm candidate:import --directory /absolute/path/to/capix/.capix/integration
pnpm install
pnpm install --frozen-lockfile
pnpm check
```

Lab 当前不能只从 npm 完成安装，因为三个私有包尚未发布。tarball 导入是明确的本地过渡分发，不使用源码软链，不把文件系统上的相邻工程当作依赖。来源记录与锁文件应共同保留；初次取得或更新候选需拿到对应产物并校验，不凭相同版本号猜测内容相同。

Lab 中 Observation 的源码阅读只开放宿主自身允许的服务文件。包里的源码位置不再被解释成可访问相邻 CAPiX 源码的权限；读取框架代码可由开发者显式打开仓库，不由宿主猜测路径。

## 4. 测试与证据交接

准确清单位于 [Lab 测试交接](../../capix-lab/docs/migration/test-handoff.json) 与 [跟踪文件交接](../../capix-lab/docs/migration/copied-paths.json)。只有已核对目标副本的跟踪文件从原位置移除；原 `.env`、数据库、生成产物和本地实验输出没有自动搬运或重置。

| 验证                                                         | 现在的位置                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| 结构、资源、调用退出、稳定值、增量 CP 和选择等纯内核保证     | CAPiX `test/`                                                     |
| 公共出口身份与 Sequence 等类型断言                           | CAPiX；原混合测试中纯核心部分另拆保留                             |
| 具体 ConversationStore／ObserverStore 的事务、损坏、持久接纳 | Lab 正式 `test/`                                                  |
| 进程中断与恢复资格、未知外部效果、CP 选择冷恢复              | 随真实宿主／Store 进入 Lab 正式测试                               |
| HTTP、客户端与真实宿主联动、UI 投影                          | Lab 正式测试；无宿主的客户端测试仍在框架                          |
| CP 计算／固定边界／SQL 查询基准                              | Lab；原夹具实际依赖 ConversationStore，保留完整内存与 SQLite 对照 |
| 事实模型与恢复对照的历史推演                                 | Lab examples 与对应报告，按历史基线说明，不算作当前机制证明       |

没有把 SQLite 故障证据换成简单内存实现，也没有为了独立构建跳过不方便的正式测试。少量两边都需要的测试夹具明确记录在交接清单，不包含框架实现。

框架改动若影响 Store、宿主恢复或跨端接纳，需要准备候选批次并执行 Lab 对应集成验收。CAPiX CI 继续负责本仓 `check` 与公开产物 `release:check`；Lab 的独立 check 脚本负责本仓，尚未配置远端 workflow。当前三个私有包尚未公开，远端自动取得候选产物的渠道也未配置，不能把本地通过说成已打通远端跨仓 CI。

## 5. 文档与公开内容

README 已以三个公开 npm 包的离线字典例子起步。CONTRIBUTING 写明工具链、检查与跨包边界；SECURITY 明确目前未确认启用的私密报告入口，不虚构邮箱、服务级别或平台安全能力。

当前契约继续留 CAPiX，服务文档和 38 份历史／宿主材料随对象迁往 Lab。历史源码证据链接固定在来源提交，原 `.capix` 产物标明未交接，不能伪装成新仓可读取的数据。

[本地内容审阅](open-source-content-audit.md) 检查了本仓可达历史和进行中的工作树，没有确认真实凭证泄漏。这不等于已完成公开审核：Actions 日志、制品、远端讨论附件尚未检查；历史中存在个人环境路径，公开历史方式仍需维护者选择。

`examples/intent/results/2026-10-29-deepseek.jsonl` 是基于合成案例生成的真实模型原文，暂保留 CAPiX 原路径等待公开保留决定，没有自动复制到 Lab 或删除。它不是保留旧实验实现的兼容入口。迁出当前文件也不会隐藏旧提交。

## 6. 验证记录

第一版验证分为框架、产物和 Lab 三部分。所有普通验证离线使用模型夹具；包安装允许访问 npm registry，没有调用真实模型。

- 20 包干净构建、类型检查；两仓分别 frozen install。
- 公开身份、路径与类型定向回归通过；框架正式回归 **1,518 通过，0 失败、0 跳过**。
- 17 个公开 tarball 的仓库外安装、出口、类型、身份与恢复验证。
- 20 包候选导入、Lab 构建／类型检查；含补入基准的正式回归 **1,838 通过，0 失败、0 跳过**。CLI 离线入口和仓库外 npm 文档例子通过。
- 候选导入器额外 **12 项**来源损坏／路径记录拒绝回归通过，拒绝后既有批次和 workspace manifests 不变。最终候选重新导入并 frozen 安装；20 包 JS／声明与完整回归所用批次逐文件一致，变化仅在来源记录和文档／元数据。
- 最终 Lab 使用新临时数据库实际完成 `--demo --input hello`，产生预览及正式回答；没有访问真实模型或改动用户原数据库。
- 当前文档链接、格式、Git diff 检查，以及旧源码路径／跨仓私有导入检查。

来源基线的 **1,591 个跟踪文件**均能定位到当前框架路径或 Lab 交接位置；原 **398 个正式测试文件**也均有归属。上述计数不把文件迁移当作删除验证。最终候选实际源摘要为 `ec8e996cbdeca27b0cd347edf88471edaa0ea0bdc5a0125c6bdd7e90b59f4012`，其基线仍为 `ff9bce4` 且 `dirty=true`，准确数据见两仓本地候选 manifest。

本地拆库不发布新的 npm 版本。候选包继续标为候选；公开历史、有效的私密漏洞通道、Lab 远端及远端候选分发留作后续明确操作。
