# @weiliang0121/capix-transcript

Append-only conversation messages and resource contracts for CAPiX.

The public root owns `Message`, `MessageLocator`, `TranscriptRangeLocator`, `TranscriptSnapshot`, and `TranscriptEvent`. Locators identify fixed positions without retaining an entity; snapshots and events describe one source revision, including segment changes. Transport framing and wire acceptance belong to the protocol adapter and are not entity recovery authority.

ES modules and TypeScript declarations. Requires Node.js 22.23.2 or newer.

```sh
npm install @weiliang0121/capix-transcript
```

## Public entry points

- `@weiliang0121/capix-transcript`
- `@weiliang0121/capix-transcript/presets`

This package is part of CAPiX. The npm distribution contains compiled JavaScript, type declarations, and this package's MIT license. Reference services and client applications are not included in this package or the initial npm release.

## License

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
