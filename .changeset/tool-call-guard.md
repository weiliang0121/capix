---
'@weiliang0121/capix-tool': minor
---

Raise the default Tool model-call guard from 8 to 1000 and accept any positive safe integer instead of limiting configuration to 32. Long tool workflows can continue beyond 32 model requests while retaining explicit cancellation, byte budgets, and the author's chosen call limit.

Export ToolModelCallLimitError with code TOOL_MODEL_CALL_LIMIT, calls, and limit so hosts can report exhaustion separately from provider failures. The guard is checked before the next model invocation; the last permitted response can finish normally, and completed tool effects are retained. Checkpoint recovery preserves the accumulated count and still rejects changed fixed configuration, including the changed default. This does not introduce token quotas or expand context, persistence, or collection capacity.
