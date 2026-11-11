# 客户端已迁入 CAPiX Lab

客户端实现、包内回归及完整行为说明由 [CAPiX Lab 客户端文档](../../capix-lab/docs/client-runtime.md)维护：`capix-lab/packages/client-runtime`、`capix-lab/packages/client-http` 是 Lab 的私有 workspace，React 绑定与展示位于 `capix-lab/apps/observer`。CAPiX 不再构建、测试或分发这两个客户端包，也不将 Lab 验收作为框架前置条件。

CAPiX 继续维护 [跨端协议](protocol.md)及公开 `@weiliang0121/capix-protocol` 的纯值与接纳定义；客户端迁出不改变协议行为。客户端通过公开包消费协议，不读取框架私有源码。
