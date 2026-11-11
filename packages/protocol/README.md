# @weiliang0121/capix-protocol

Explicit Transcript baseline, delta and error wire values, with single-frame admission. The only public entry point is the package root.

```sh
npm install @weiliang0121/capix-protocol
```

```ts
import { acceptTranscriptUpdate, type TranscriptUpdate } from '@weiliang0121/capix-protocol';

const update: TranscriptUpdate = acceptTranscriptUpdate(JSON.parse(payload));
if (update.type === 'baseline') console.log(update.snapshot.messages);
```

`acceptTranscriptUpdate` validates one complete value, rejects unknown fields and invalid message/range/segment/revision shapes, and returns fixed data. This does not establish delivery continuity, replace a consumer's source, authorize recovery or implement HTTP. Those responsibilities belong to the consuming application.

Public types: `TranscriptWireMessage`, `TranscriptWireSnapshot`, `TranscriptWireEvent`, `TranscriptFrame`, `TranscriptUpdate`. These are explicit transport representations; entity APIs belong to `capix-transcript`. Invocation events belong to `capix-invocation/events`, record data and validation to `capix-records/data`, and shared relation identity to `capix-contracts`.

The former `content`, `invocation`, `recording`, `conversation` and `observer` subpaths have been removed. Reference service DTOs and endpoint admission are maintained by the separate CAPiX Lab workspace. This package does not reexport entity implementations or business protocols.

ES modules and TypeScript declarations. The npm distribution contains compiled JavaScript, declarations, this README and the MIT license; no HTTP, Node-specific implementation or UI dependency is introduced by this entry point.

## License

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
