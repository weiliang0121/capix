# 客户端已迁入 CAPiX Lab

客户端实现、包内回归及完整行为说明由 [CAPiX Lab 客户端文档](../../capix-lab/docs/client-runtime.md)维护：`capix-lab/packages/client-runtime`、`capix-lab/packages/client-http` 是 Lab 的私有 workspace，React 绑定与展示位于 `capix-lab/apps/observer`。CAPiX 不再构建、测试或分发这两个客户端包，也不将 Lab 验收作为框架前置条件。

CAPiX 继续维护 [跨端协议](protocol.md)中的 Transcript wire 与单帧接纳；Conversation／Observer 的业务 DTO、端点接纳和消费生命周期归 Lab。客户端迁出阶段保持行为，后续框架领域与协议出口已发生修订，Lab 仍需显式迁移其固定候选的消费者。客户端通过公开包消费框架契约，不读取框架私有源码。
