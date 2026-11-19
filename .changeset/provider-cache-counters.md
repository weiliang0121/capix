---
'@weiliang0121/capix-model-provider': minor
---

Chat Completions JSON and SSE expose the standard nested cached input count when the DeepSeek hit count is absent. Anthropic Messages and OpenAI Responses preserve reported cache writes across JSON, SSE and reply storage as the optional `ModelUsage.promptCacheWriteTokens` field. Partial Messages replies expose the known write count through `modelReplyUsage`. Input and total counts already include these writes.

Updated readers accept existing v1 replies with omitted write counts. Consumers restoring replies containing the new field need the updated model-provider reader throughout their assembly. Runtime dependencies are unchanged.
