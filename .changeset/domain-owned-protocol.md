---
'@weiliang0121/capix-contracts': minor
'@weiliang0121/capix-transcript': minor
'@weiliang0121/capix-measurement': patch
'@weiliang0121/capix-invocation': minor
'@weiliang0121/capix-records': minor
'@weiliang0121/capix-runtime': patch
'@weiliang0121/capix-protocol': minor
---

Move Message, transcript locators/snapshots/events to transcript; shared InvocationRelationIdentity to contracts; invocation events and stage vocabulary to invocation/events; record data, archive validation and output helpers to records/data. The two data subpaths do not load their Node-specific mechanism or entity implementations. Remove protocol dependencies from domain and runtime packages.

Narrow protocol to the root TranscriptWireMessage/Snapshot/Event, TranscriptFrame/Update and acceptTranscriptUpdate exports. Remove content, invocation, recording, conversation and observer subpaths. Conversation/Observer business DTOs and endpoint admission now belong to the independent Lab workspace; consumers must update their imports and service-specific contracts explicitly. No old-data migration or compatibility reexports are included.

Single-frame Transcript admission validates and fixes JSON-compatible values without claiming stream continuity, connection ownership or recovery authority. Domain exports, wire admission, isolated package consumption and framework record invariants are independently tested in CAPiX.

Accept gaps in resource record sequence numbers because domain facts share the same call-local sequence and are projected separately. Snapshot validation and record-book restoration still require strict order, valid identities, binding phases and operation pairs.
