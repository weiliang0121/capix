# Strict object inspection experiment

`strict-inspection.js` supplies the same shallow object fixtures to each engine. Its `run(classify)` checks the classification and requires zero calls to the input's getters, proxy traps, or native host hooks. A candidate must identify transparent, forwarding, nested, throwing, and revoked object and array proxies before reading metadata. Ordinary records, null-prototype records, frozen data, and arrays provide acceptance controls. The Hermes host also supplies a traced JSI `HostObject`.

The engine probes isolate the host capability needed before inspecting untrusted object metadata. Each probe uses a fresh runtime and trusted built-ins.

The Node public-boundary check reuses the 17 JavaScript fixtures through the built package exports. It feeds each sample to `createViewSource().read()` and to `View.captureSync()` and `View.capture()` using a direct source. Accepted samples appear as fixed snapshot content. It also nests each sample in a tool parameter schema's `examples` array, a slot that permits both records and arrays, and calls `requireModelRequest()`. The validator returns the original accepted request. At each boundary the check requires `TypeError` for invalid samples and zero getter or proxy trap calls.

## Run

From the repository root, run the combined Node check after building the workspace packages. `pnpm check` runs it after the build.

```sh
pnpm test:platform
```

The standalone Node engine probe also runs without built package output.

```sh
node scripts/platform/check-strict-inspection.mjs
```

Run the Hermes sample with Xcode and matching Hermes/JSI headers, a prebuilt `hermesvm.framework`, and `hermesc`. Set `HERMES_INCLUDE` to the directory containing `hermes/hermes.h` and `jsi/jsi.h`, `HERMES_FRAMEWORK_DIR` to the parent of the macOS framework, and `HERMESC` to the compiler executable. The launcher compiles the repository fixture and native sample into a temporary directory.

```sh
bash scripts/platform/check-hermes-inspection.sh "$HERMES_INCLUDE" "$HERMES_FRAMEWORK_DIR" "$HERMESC" reflection
bash scripts/platform/check-hermes-inspection.sh "$HERMES_INCLUDE" "$HERMES_FRAMEWORK_DIR" "$HERMESC" internal-test-methods
```

For iOS Simulator, use the simulator slice's framework parent and a booted simulator UDID.

```sh
xcrun simctl list devices booted
bash scripts/platform/check-hermes-inspection.sh "$HERMES_INCLUDE" "$HERMES_SIMULATOR_FRAMEWORK_DIR" "$HERMESC" reflection "$SIMULATOR_UDID"
bash scripts/platform/check-hermes-inspection.sh "$HERMES_INCLUDE" "$HERMES_SIMULATOR_FRAMEWORK_DIR" "$HERMESC" internal-test-methods "$SIMULATOR_UDID"
```

The launchers emit a JSON report. A fixture failure exits with status 1. The default Hermes reflection mode is expected to fail each proxy fixture on the version below. Build, launch, and runtime setup failures have their own diagnostics.

## Observed results

| Host and engine                                                           | Candidate                                                           | Passed |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- | -----: |
| macOS 26.6.2 arm64, Node 22.23.2                                          | `node:util.types.isProxy` and JavaScript descriptors                |  17/17 |
| Same Node host                                                            | View source read, sync and async capture, and `requireModelRequest` |  68/68 |
| macOS 26.6.2 arm64 and iPhone 17 iOS 27.2 Simulator, Hermes 260318099.0.5 | Default runtime and JavaScript descriptors                          |  10/18 |
| Same Hermes hosts, Release build, bytecode version 99                     | Test-only `HermesInternal.isProxy` and JS descriptors               |  18/18 |

Default Hermes reflection classified transparent and forwarding proxies as ordinary objects, ran metadata traps on instrumented proxies, and threw while inspecting revoked proxies. Descriptor lookup on ordinary accessor objects avoided invoking their getters.

The tested JSI `getProperty` invoked a getter. `getPrototype` and `getPropertyNames` invoked proxy traps. `hasNativeState` returned `false` for both an untagged record and a proxy. `setNativeState` rejected the proxy without a trap and attached native state to the ordinary record, so the write cannot serve as read-only evidence. `isHostObject` identified the native fixture without invoking its hooks. [Public JSI header](https://github.com/facebook/hermes/blob/static_h/API/jsi/jsi/jsi.h)

The passing strict Hermes probe creates its own runtime with `EnableHermesInternalTestMethods` explicitly enabled. Upstream registers the proxy predicate with test methods and documents that the group can change language semantics. The default runtime exposes no such predicate. These rows establish the behavior of the engine probe in the listed runtimes. [Hermes runtime configuration](https://github.com/facebook/hermes/blob/static_h/public/hermes/Public/RuntimeConfig.h), [Hermes test-method registration](https://github.com/facebook/hermes/blob/static_h/lib/VM/JSLib/HermesInternal.cpp)

## Production interface review

In Hermes 260318099.0.5 the VM reads the proxy flag directly. The public JSI native-state reader requires a previous successful state check. Its setter creates a state cell even for a null pointer and can overwrite existing state. The external-memory setter also modifies object-associated state. The DevTools object converter can read properties such as `constructor`. None of these operations provides a read-only, trap-free proxy predicate for arbitrary inputs. [VM predicate and registration](https://github.com/facebook/hermes/blob/hermes-v260318099.0.5/lib/VM/JSLib/HermesInternal.cpp#L423-L427), [native-state and external-memory operations](https://github.com/facebook/hermes/blob/hermes-v260318099.0.5/API/hermes/hermes.cpp#L2554-L2665), [DevTools conversion](https://github.com/facebook/hermes/blob/hermes-v260318099.0.5/API/hermes/cdp/RemoteObjectConverters.cpp#L29-L49)

Strict CAPiX inspection on Hermes would require a supported read-only engine predicate and JSI host-object rejection before reflection. Node uses its native predicates automatically. A non-Node host can install a trusted adapter with `installObjectInspection`. On standard Hermes, CAPiX rejects inputs at boundaries that require object inspection until the host selects a policy.

Apps that control the objects supplied to CAPiX can explicitly call `useAuthorProvidedPlainObjects()` on standard Hermes. Authors must exclude proxies and JSI `HostObject` values from inspected objects, their nested contents and any prototype chains CAPiX traverses. Capability ports still take the declared structures, methods and resource handles. Data ports still enforce their shape, descriptor, cycle and budget rules. If the author guarantee fails, reflection can run proxy traps or host hooks, throw or accept a disguised value. To create ordinary data from an external source, start from primitive data such as JSON text and use a trusted parser without a reviver. [Host object inspection](../../docs/runtime-boundaries.md#宿主对象检查)

The stock macOS and iOS Simulator Release frameworks both expose `Error.isError`. It recognized a genuine error after its prototype was set to null. It returned false for a record inheriting from `Error.prototype`, a throwing proxy and a revoked proxy around the genuine error, and a JSI HostObject. The probe recorded zero traps and host hooks. The implementation checks the VM's `JSError` type directly. [Error brand implementation](https://github.com/facebook/hermes/blob/hermes-v260318099.0.5/lib/VM/JSLib/Error.cpp#L453-L464)

The bundled Promise constructor initializes ordinary instance fields. A record created with the same prototype and a copy of all own descriptors passed `instanceof Promise` on both hosts. Calling the bundled `Promise.prototype.then` would read the input's constructor and register a continuation. `HermesInternal.hasPromise()` reports a runtime capability and takes no input. These operations cannot authenticate an arbitrary Promise without side effects. [Bundled Promise implementation](https://github.com/facebook/hermes/blob/hermes-v260318099.0.5/lib/InternalJavaScript/01-Promise.js#L53-L80), [Runtime Promise capability](https://github.com/facebook/hermes/blob/hermes-v260318099.0.5/lib/VM/JSLib/HermesInternal.cpp#L429-L431)

On both hosts, `IHermes::getUniqueID` identified each sample individually. Its public contract describes identity over the object's lifetime. `getHeapInfo(false)` returned 22 aggregate counters. `createSnapshotToStream` threw because these Release frameworks were built without memory instrumentation. When compilation enables it, the implementation runs a garbage collection and writes a snapshot of the whole heap. These APIs provide no per-object brand query. [Object identity API](https://github.com/facebook/hermes/blob/hermes-v260318099.0.5/API/jsi/jsi/hermes-interfaces.h#L136-L153), [Heap counters](https://github.com/facebook/hermes/blob/hermes-v260318099.0.5/API/hermes/hermes.cpp#L423-L460), [Heap snapshot implementation](https://github.com/facebook/hermes/blob/hermes-v260318099.0.5/API/hermes/hermes.cpp#L562-L576)

## Public feature matrix

Copy `feature-matrix.mjs` into an isolated production consumer with all CAPiX packages and the workspace's pinned Zod version installed. The fixture uses public ESM entry points, synthetic data, and an offline model sender. On Node, run the fixture with the built-in inspection policy.

```js
import { runFeatureMatrix } from './feature-matrix.mjs';

const rows = await runFeatureMatrix();
console.log(JSON.stringify(rows, null, 2));
```

In an iOS Expo/Hermes app with `expo-crypto`, use a Metro version that supports package `exports` and `imports` with the React Native resolution conditions. The CAPiX package imports select their `default` targets on iOS. Configure CAPiX before the fixture or any other CAPiX consumer is evaluated. The dynamic import runs after configuration so that checks and Offer UUID allocation during module initialization use the configured platform. Call `runCapixMatrix()` from the app. [iOS app entry example](../../packages/platform/README.md#ios-hermes-启动), [Metro module resolution](https://metrobundler.dev/docs/resolution/)

```js
import { randomUUID } from 'expo-crypto';
import { installRandomUUID, useAuthorProvidedPlainObjects } from '@weiliang0121/capix-platform';

useAuthorProvidedPlainObjects();
installRandomUUID(randomUUID);

export async function runCapixMatrix(options) {
  const { runFeatureMatrix } = await import('./feature-matrix.mjs');
  return runFeatureMatrix(options);
}
```

Each row runs independently and reports its assertions as a single pass or failure. Some multi-stage checks also record which steps completed before an exception. Run the stock-host baseline in a fresh app runtime with the UUID setup and without `useAuthorProvidedPlainObjects()` to see the boundaries that require a policy. The author mode exercises the public features on inputs controlled by the fixture. The strict engine probe above measures whether the engine can recognize arbitrary proxies before reflection. For a release bundle, compare public entry names and exports to the same installed archives on Node and inspect the Metro source map for the selected platform and reception implementations. App bundling, installation, and launch are separate from the repository checks.

The two Tool scenarios exercise the Chat Completions provider with JSON and SSE responses. Both require the provider to encode the tool's feedback in a second request. The SSE scenario also checks the emitted text. The default fetch reads fixture bytes in memory. For a host transport test, serve `modelFixtureResponse(body, pathname)` on loopback, writing its `parts` in order with the returned `contentType`, and pass `{ endpoint, fetch }` to `runFeatureMatrix`.

### Release app results

The 2026-11-22 run used 21 candidate archives built from source fingerprint `af4d17f76034`. The stock Hermes app ran in an iPhone 17 simulator on iOS 27.2. Each iOS configuration started in a fresh process with the same native Release executable and Hermes 260318099.0.5.

| Host         | Object inspection policy                                  | Passed |
| ------------ | --------------------------------------------------------- | -----: |
| Node 22.23.2 | Native checks                                             |  29/29 |
| iOS Hermes   | Default, no object inspection policy installed            |  14/29 |
| iOS Hermes   | Author provides data free of proxies and JSI host objects |  29/29 |

The author-configured app executed Sequence and Dynamic groups and recorded the correct Transcript write for each of two child receptions completed in reverse order. The checkpoint case serialized the saved image in memory, loaded it into a fresh `MemoryCheckpointStore`, and resumed a new Runner in the same app process. Device-storage persistence and recovery after process termination require a host store and a separate restart test. Seven loopback HTTP requests exercised the four model protocols, including two complete Chat Completions tool exchanges with JSON and SSE delivery. The default run issued no HTTP requests. Both Metro bundles resolved the 33 portable public entry points to the installed candidates. These runs exercised a synthetic consumer in the simulator and used local model responses.

The same archives were checked against 484 existing package tests from 104 files across 12 packages. Node passed 484/484. The iOS Release app ran the test bodies with a portable test registrar and strict assertion library. With its default global `Response` constructor, it passed 459/484. In a separate complete run, four Tool test files returned their fixture bytes through loopback HTTP using `expo/fetch`; this supplied readable response streams and the app passed 482/484. The two remaining tests exercise Node’s implicit reception tracking with `AsyncLocalStorage`. The comparable cross-platform fixed writes use the explicit reception permit. The full package and repository test suites run under Node.
