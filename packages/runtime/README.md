# @weiliang0121/capix-runtime

Structure binding, resource assembly, and Runner for CAPiX.

ES modules and TypeScript declarations. Requires Node.js 22.23.2 or newer.

```sh
npm install @weiliang0121/capix-runtime
```

## Public entry points

- `@weiliang0121/capix-runtime`
- `@weiliang0121/capix-runtime/construction`
- `@weiliang0121/capix-runtime/recording`

This package is part of CAPiX. The npm distribution contains compiled JavaScript, type declarations, and this package's MIT license. Reference services and client applications are not included in this package or the initial npm release.

Runtime composes Invocation progress through `invocation/events` and recording through the public `records/data` contracts. It does not depend on transport or service protocols. Optional content recording uses the domain adapters owned by `records`; it adds no entity lifecycle or direct production dependency on Transcript or Memory.

## License

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
