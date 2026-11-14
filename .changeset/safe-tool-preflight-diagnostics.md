---
'@weiliang0121/capix-tool': minor
---

Return bounded schema-safe field paths and static reason/type diagnostics for rejected tool arguments, with explicit preflight/nonexecution markers. Exclude argument values, arbitrary keys and custom validation messages; retain strict validation without coercion or retry. Advance the catalog precheck policy to version 2: prior Tool checkpoints are rejected without migration, while current feedback is verified on cold recovery.
