# @weiliang0121/capix-interaction

Independent external interactions, persisted feedback, and bounded progress streams for CAPiX.

ES modules and TypeScript declarations. Requires Node.js 22.23.2 or newer.

```sh
npm install @weiliang0121/capix-interaction
```

## Public entry points

- `@weiliang0121/capix-interaction`

This package is part of CAPiX. The npm distribution contains compiled JavaScript, type declarations, and this package's MIT license. Reference services and client applications are not included in this package or the initial npm release.

## Data limits and restoration

`InteractionOptions.limits` and `InteractionRegistration.limits` accept `InteractionDataLimits`:

- `requestTextUnits` bounds each request before and after the request contract runs.
- `replyTextUnits` bounds each feedback payload before and after the reply contract runs.

Each defaults to `DEFAULT_INTERACTION_TEXT_UNITS` (`16 * 1024 * 1024`). Values must be positive safe integers no greater than `MAX_INTERACTION_TEXT_UNITS` (`64 * 1024 * 1024`). A text unit is one UTF-16 code unit, measured by JavaScript `string.length`; string values and object keys both count. These are not UTF-8 byte or model token limits. The two payload budgets are independent: increasing request capacity leaves reply capacity unchanged. For example, `{ limits: { requestTextUnits: MAX_INTERACTION_TEXT_UNITS } }` admits an assembled request containing 48 Mi text units, including its keys.

Limits are copied and fixed when an interaction is constructed or a contract is registered. `Interaction.restore(state, { contract, limits })` must receive the same limits as the original construction. Registration persistence reads automatically reuse the registration's fixed limits. Saved requests and feedback are captured again and must remain equivalent after their contracts run. Restoration writes no data and reconstructs no sender; restored interactions cannot resend.

Request, feedback payload, state metadata, feedback metadata and failure diagnostics are captured in separate domains. Metadata and failure diagnostics retain the default text bound. Each domain retains the structural limits of depth 64 and 100,000 visited values, regardless of the configured text bound. Consequently a request and reply of 9 Mi text units each can both be read after persistence; restoration does not charge their combined size against one payload limit.

Only passive JSON-shaped data is accepted. Proxies, getters, non-enumerable or symbol properties, sparse arrays, cycles and unsupported objects are rejected before contracts inspect payloads. State and feedback wrappers also reject extra fields; feedback requires exactly `id` and `payload`. Rejected feedback and restoration leave saved data unchanged and never retry a send.

## License

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
