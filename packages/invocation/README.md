# @weiliang0121/capix-invocation

Invocation lifecycle, child relations, reception, output, and checkpoint activity for CAPiX.

ES modules and TypeScript declarations. Requires Node.js 22.23.2 or newer.

```sh
npm install @weiliang0121/capix-invocation
```

## Public entry points

- `@weiliang0121/capix-invocation`
- `@weiliang0121/capix-invocation/events`

This package is part of CAPiX. The npm distribution contains compiled JavaScript, type declarations, and this package's MIT license. Reference services and client applications are not included in this package or the initial npm release.

`/events` owns the pure `InvocationEvent` data contract and its process stage, action, and relation phase vocabulary. It imports no live invocation implementation or Node APIs. The root explicitly exports the same definitions. Shared callable kinds, failure facts and relation identity belong to `contracts`; transport framing belongs to its adapter.

## License

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
