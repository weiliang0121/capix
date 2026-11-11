---
'@weiliang0121/capix-memory': minor
'@weiliang0121/capix-protocol': minor
'@weiliang0121/capix-records': minor
'@weiliang0121/capix-runtime': patch
---

Make Memories an independent summary collection: stable items have UUIDs and `{content, metadata?}` values, with no Transcript ownership, reserved topic, or required sources. Replace mutable Memory instances and the MemoryResource singleton with fixed reads and the typed memoryResources factory. Writes preserve batch atomicity, explicit basis checks and exact fixed-operation confirmation; state and fixed requests now require version 2 with no legacy migration.

Reject current reads and new writes after an uncertain persistence result, while preserving already acquired material and accurate old receipts. Keep publication failure distinct from commit uncertainty. Metadata uses the Stable data domain; persistence and checkpoint adapters must explicitly encode their supported values.

Move domain Memory types into the memory package. Default records project only summary content and optional change reason, with matching baseline and incremental semantics. MemoryContent/MemoryEvent protocol exports and the old topic/source wire fields are removed; service-specific wire projections belong to their consumers. View indexing and Frame v6 semantics are unchanged; downstream host policies and codecs require explicit adaptation.
