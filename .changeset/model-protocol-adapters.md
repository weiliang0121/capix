---
'@weiliang0121/capix-model-provider': minor
---

Add OpenAI Responses, Anthropic Messages and Gemini generateContent alongside Chat Completions. All four adapters support JSON and SSE, client tool calls, exact request inspection, wire-size reservation and bounded protocol diagnostics. Responses supports explicit history replay and stored-response continuation. Messages preserves signed blocks; Gemini preserves ordered parts and marks locally assigned reply IDs and configured model names when upstream metadata is absent.

Generic consumers can use `readModelToolArguments` for tool inputs and `modelReplyUsage` for known common counters, including partial Messages measurements. `reply.usage` and completed attempt events continue to require complete counts. Narrow the native format before reading protocol-specific fields. Concrete Chat calls and stored Chat v1 replies keep their existing shape.
