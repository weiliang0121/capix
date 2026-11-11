# @weiliang0121/capix-view

Versioned views over independently owned content for CAPiX.

ES modules and TypeScript declarations. Requires Node.js 22.23.2 or newer.

```sh
npm install @weiliang0121/capix-view
```

## Public entry points

- `@weiliang0121/capix-view`

This package is part of CAPiX. The npm distribution contains compiled JavaScript, type declarations, and this package's MIT license. Reference services and client applications are not included in this package or the initial npm release.

## Adapting author-owned data

`createViewSource` optionally implements the existing synchronous source contract from four callbacks. It does not create an entity, own a container, persist data, or manage a resource access window.

```ts
import { createViewSource, View } from '@weiliang0121/capix-view';

const documents = new Map<string, { title: string; text: string }>([['guide', { title: 'Guide', text: 'Read this first.' }]]);
let revision = 0;
const requireDocument = (key: string) => {
  if (!documents.has(key)) throw new RangeError('Document is missing or outside scope');
  return documents.get(key)!;
};
const source = createViewSource({
  id: 'local-documents',
  scope: 'whole',
  version: () => String(revision),
  keys: () => [...documents.keys()],
  inspect: (key) => ({ title: requireDocument(key).title }),
  read: (key) => requireDocument(key),
});
const sources = { documents: source };
const view = new View<typeof sources>({ revision: 0, sources: { documents: { id: source.id, scope: source.scope } }, members: [{ source: 'documents', key: 'guide' }] });
const index = view.indexSync(sources);
const snapshot = view.captureSync(sources, index);

documents.set('guide', { title: 'Guide', text: 'Updated instructions.' });
revision++; // Every observable source change requires a new, never-reused version.
```

The adapter fixes `id`, `scope`, and callback selection at construction, preserving each callback's original receiver. `version()` must cover directory order, membership, summaries, and values for that identity and scope. It must never reuse an earlier version. The adapter compares stamps before callbacks and after result isolation; it rejects changes and reentrant source operations without retrying. It cannot detect an author changing content without changing its version.

`keys()` supplies the complete directory for this scope. Keys must be nonempty strings or nonnegative safe integers, with no duplicates. `index()` validates this directory and calls `inspect(key)` for each entry; it never reads bodies. `inspect(keys)` calls only the selected metadata callbacks, and `read(keys, expected)` calls only the selected body callbacks after checking the expected stamp. Neither selected operation calls `keys()`, and reading does not call `inspect()`. Directory work scales with the directory; selected work scales with the requested keys and returned data.

Authors must check missing keys and scope in both `inspect(key)` and `read(key)` and throw `RangeError` when access is invalid. Key shape validation is not a scope or authorization check. `undefined` is a valid summary or body, so it cannot indicate a missing key. All callbacks must finish synchronously; Promise and thenable results are rejected, and rejected asynchronous results are observed.

Summaries and bodies must be passive scalar values, dense arrays, or ordinary data records. The adapter detaches and recursively freezes returned data without freezing the source, configuration, or author-owned values. Accessors, proxies, live objects, functions, cycles, and unsupported scalar values are rejected. `ViewSourceData<T>` describes the readonly result shape; it grants no runtime `Stable` evidence, persistence format, or recovery guarantee.

Custom `SyncViewSource` and asynchronous `ViewSource` implementations remain valid. No source identity interface or new source kind is required for those implementations. A resource adapter still uses `openView` or `openViewManager` to enforce its access window; `createViewSource` alone provides no resource permission or lifecycle.

## License

MIT. Copyright (c) 2026 wei.liang. See [LICENSE](LICENSE).
