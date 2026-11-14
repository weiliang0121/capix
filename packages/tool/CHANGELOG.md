# @weiliang0121/capix-tool

## 0.3.0

### Minor Changes

- d5f0369: Raise the default Tool model-call guard from 8 to 1000 and accept any positive safe integer instead of limiting configuration to 32. Long tool workflows can continue beyond 32 model requests while retaining explicit cancellation, byte budgets, and the author's chosen call limit.

  Export ToolModelCallLimitError with code TOOL_MODEL_CALL_LIMIT, calls, and limit so hosts can report exhaustion separately from provider failures. The guard is checked before the next model invocation; the last permitted response can finish normally, and completed tool effects are retained. Checkpoint recovery preserves the accumulated count and still rejects changed fixed configuration, including the changed default. This does not introduce token quotas or expand context, persistence, or collection capacity.

### Patch Changes

- @weiliang0121/capix-checkpoint@0.3.0
  - @weiliang0121/capix-contracts@0.3.0
  - @weiliang0121/capix-diagnostics@0.3.0
  - @weiliang0121/capix-interaction@0.3.0
  - @weiliang0121/capix-model-exchanges@0.3.0
  - @weiliang0121/capix-model-provider@0.3.0
  - @weiliang0121/capix-resources@0.3.0
  - @weiliang0121/capix-structure@0.3.0

## 0.2.0

### Minor Changes

- ea6d5b3: Add the Tool Group preset with inline typed members, fixed exchange origins, ordinary resource registration, bounded serial model/tool execution, and explicit checkpoint recovery. No per-member factory, special Runner branch, or capture-based resource installer is required.

### Patch Changes

- Updated dependencies [972d478]
- Updated dependencies [ea6d5b3]
- Updated dependencies [8c25149]
  - @weiliang0121/capix-contracts@0.2.0
  - @weiliang0121/capix-model-exchanges@0.2.0
  - @weiliang0121/capix-resources@0.2.0
  - @weiliang0121/capix-checkpoint@0.2.0
  - @weiliang0121/capix-diagnostics@0.2.0
  - @weiliang0121/capix-interaction@0.2.0
  - @weiliang0121/capix-structure@0.2.0
  - @weiliang0121/capix-model-provider@0.2.0
