---
'@weiliang0121/capix-model-provider': minor
'@weiliang0121/capix-model-exchanges': patch
'@weiliang0121/capix-tool': patch
---

Chat Completions 的 `ModelRequest.trailingMessages` 可以在闭合交换及工具图片附件后追加本次请求的消息。检查、预留和发送计入完整尾部，其他内置协议在发送前拒绝非空尾部。ModelExchanges 与 Tool 固定起点的类型继续只接受前缀消息。
