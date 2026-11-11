---
'@weiliang0121/capix-changes': minor
'@weiliang0121/capix-contracts': patch
'@weiliang0121/capix-protocol': patch
'@weiliang0121/capix-resources': minor
'@weiliang0121/capix-invocation': minor
'@weiliang0121/capix-transcript': patch
'@weiliang0121/capix-memory': patch
'@weiliang0121/capix-records': minor
'@weiliang0121/capix-runtime': minor
---

Replace transcript/memory observation ports with typed, operation-scoped domain facts. FactType owns a fixed body and matches by exact producer identity. ResourceOperation.facts supplies a synchronous publisher that closes before result reception; new domain entities need no Invocation or checkpoint activity union changes.

InvocationOrigin now belongs to contracts, with the same explicit protocol export. Resources and changes no longer depend on protocol. The default record adapter preserves content records; RecordingOptions.fact allows explicit business projections. Runner exposes source: fact and checkpoint kind: fact metadata in place of the two content-specific checkpoint summaries. Frame v6 and recovery promises are unchanged.

Reject publication after reentrant access closure and reject widening typed publishers. Existing low-level transcriptObservation/memoryObservation and observer transcript/memory methods must migrate to the new fact interface; there is no legacy alias.
