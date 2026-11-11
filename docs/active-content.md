# Observer 活跃材料的参考装配边界

ActiveView、ConversationContent、默认内容纳入策略、变化消费、原文同步及其测试已整体迁至 `capix-lab/services/observer-content`。完整行为说明与宿主恢复依据见 [Lab 活跃材料文档](../../capix-lab/docs/active-content.md)。它们是 Observer 参考装配，尚未抽象或发布为通用公开预设，不在 CAPiX 的包、候选 tarball 或框架测试清单中。

CAPiX 继续维护 [Transcript](transcript.md)、[Memory](memory.md)、[View](view-package.md)、[Resources](resources-package.md) 及其不变量和回归。View 提供来源与成员机制；哪些消息和记忆默认纳入、何时退出及怎样同步由 Lab 决定。退出视图不删除实体，业务策略不扩大共享机制的恢复或事务承诺。

CAPiX 的构建、测试和分发验收独立完成，不要求检出或运行 Lab。Lab 的参考装配维护自己的组合与持久化测试；发现框架违约时，应在 CAPiX 中建立独立回归。两仓链接供并排检出时参考，不是框架运行依赖。
