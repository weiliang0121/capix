# @weiliang0121/capix-records

Optional recording entities and resource packages/contracts for CAPiX.

ES modules and TypeScript declarations. Requires Node.js 22.23.2 or newer.

```sh
npm install @weiliang0121/capix-records
```

## Public entry points

- `@weiliang0121/capix-records`
- `@weiliang0121/capix-records/construction`
- `@weiliang0121/capix-records/data`

The root entry exports live record entities and recording helpers. The `data` entry owns their plain record shapes, archive identities, change records, output resolution, and full subtree/body validation. It has no Node.js or live-entity imports and is suitable for browser and wire consumers. Identically named data interfaces and entity classes are deliberately separated by these entries.

`CallableRecordHelper.snapshot` reads the caller-selected invocation subtree and its actual ancestor path; selecting a business task, Observer overview, and environment aggregation remain application responsibilities. `ExecutionRecordHelper.snapshot` and the corresponding legacy-named validators retain their existing record representation and validation; these APIs do not upgrade old data or resume execution. Memory recording and `observeMemory` expose only `MemoryRecordContent` (`content`) and available records, not arbitrary metadata or recovery material.

This ownership change removes the dependency on `capix-protocol`. Consumers of the former protocol recording/archive exports must import `capix-records/data`; shared invocation vocabulary belongs to `capix-contracts`.

`ResourceRecord.sequence` retains the owning call's shared resource order, which also numbers forwarded domain facts. Because those facts are projected separately or intentionally left uninterpreted, resource record numbers may have gaps. Subtree validation and record-book restoration require positive safe integers in strictly increasing order per owner; identity, binding phases, and started/returned/threw pairing remain checked. Missing numbers do not establish missing effects or authorize replay.

This package is part of CAPiX. The npm distribution contains compiled JavaScript, type declarations, and this package's MIT license. Reference services and client applications are not included in this package or the initial npm release.

## License

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
