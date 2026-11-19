---
'@weiliang0121/capix-model-provider': minor
---

Add OpenAI Responses, Anthropic Messages and Gemini generateContent alongside Chat Completions. All four adapters support JSON and SSE, client tool calls, exact request inspection, wire-size reservation and bounded protocol diagnostics. Responses supports explicit history replay and stored-response continuation. Its stream reconciles optional defaults in item and response completion snapshots using the JSON reply rules. Messages preserves signed blocks; Gemini preserves ordered parts and marks locally assigned reply IDs and configured model names when upstream metadata is absent.

Generic consumers can use `readModelToolArguments` for tool inputs and `modelReplyUsage` for known common counters, including partial Messages measurements. `reply.usage` and completed attempt events continue to require complete counts. Narrow the native format before reading protocol-specific fields. Concrete Chat calls and stored Chat v1 replies keep their existing shape.

Responses checks echoed storage and predecessor fields on every response snapshot, emits empty logprobs on text replay and checks that tool call IDs fit the function output schema. Messages accepts cumulative usage updates after the stop reason. A final tool input cut short by `max_tokens` yields an incomplete reply with the preceding complete blocks. Wire reservations account for the provider encoding of a changing context message.
