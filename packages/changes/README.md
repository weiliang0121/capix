# @weiliang0121/capix-changes

Change capture and delivery for CAPiX entities.

ES modules and TypeScript declarations. Requires Node.js 22.23.2 or newer.

```sh
npm install @weiliang0121/capix-changes
```

## Public entry points

- `@weiliang0121/capix-changes`

This package is part of CAPiX. The npm distribution contains compiled JavaScript, type declarations, and this package's MIT license. Reference services and client applications are not included in this package or the initial npm release.

## Typed facts

`FactType<Event>` creates an opaque, frozen `Fact` for local forwarding. Only the exact token's `match(fact, consume)` reads its deeply fixed `Stable<Event>` body; names describe tokens and do not establish identity.

`Fact` is an in-process carrier with a private symbol marker and WeakMap evidence. It is not a formal delivery value or checkpoint payload: `stableValue(fact)` rejects it rather than cloning away its identity. Read the body through `match` and explicitly encode that stable data when saving it. Copying the marker does not grant access to a fact's body.

## License

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
