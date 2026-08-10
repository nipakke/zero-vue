# Repository Guidelines

## Project Overview

**@nipakke/zero-vue** is a thin Vue 3 reactivity adapter over the **Zerodotdev/Zero** sync engine (`@rocicorp/zero`). It exposes composables (`useQuery`, `useMutation`, `useConnectionState`, `createBindings`) and a `VueView` class that wrap Zero's materialized views, mutations, and connection state as Vue reactive refs, so a Vue app can query and mutate local/offline-first data declaratively.

This is a **library repo** with a bundled demo app. Public surface is exported from `src/index.ts`; Zero types/values are imported directly from `@rocicorp/zero`.

## Architecture & Data Flow

```
Vue component
  │  calls composables
  ▼
useQuery / useMutation / useConnectionState / createBindings (src/)
  │  wrap Zero materialized views + connection state
  ▼
Zero instance (offline-first: IDB/in-memory, optional sync server)
  └─ @rocicorp/zero ── imported directly by src/ and consumers
```

Data flow: a query signal is turned into a Zero `Query`, materialized via `zero.materialize(query, vueViewFactory, {ttl})`, which produces a `VueView` implementing Zero's IVM view contract (`input.fetch()` + incremental `push()` + transaction-commit flush). `useQuery` holds that view in a single `shallowRef` and derives read-only `computed`s from it — `data`, `status` (`'complete' | 'unknown' | 'error' | 'disabled'`, `'disabled'` when the query is off), and `error` (`{ retry, type, message, details? }` or `undefined`). Reactivity is driven by `watch`, and views tear down on unmount or when the query hash/zero changes.

Key modules:

- `src/index.ts` — public barrel. Exports `useConnectionState`, `createBindings`, `useQuery`, `useMutation` (+ types `QueryResult`, `MaybeQueryResult`, `QueryError`, `QueryStatus`, `UseQueryOptions`, `UseMutationOptions`, `MutationResult`), `VueView`, `MutationTimeoutError`, `DEFAULT_MUTATION_TIMEOUT_MS`.
- `src/query.ts` — the primary `useQuery(zero, querySignal, options?)` composable. Returns `{ data, error, status }` as read-only `computed`s derived from a materialized-view `shallowRef` (a.k.a. `QueryResult`; `MaybeQueryResult` allows `undefined` data). Reactive `watch([zero, hash, refetchKey])` materializes a `VueView` per query via the factory overload; watches TTL separately; cleans up on unmount (guarded by `getCurrentInstance()`).
- `src/mutation.ts` — the `useMutation(zero, mutationFn, options?)` composable. `mutationFn` returns a `MutateRequest` from a registered custom mutator (`mutators.x(...)`); the composable executes it against the current zero and `mutate` returns the resulting `MutatorResult` (`{client, server}`) for independent awaiting. Tracks `isPending`/`error` computed refs, races the tracked promise (`awaitMode`: `'client'` default, `'server'`) against `options.timeout` (`DEFAULT_MUTATION_TIMEOUT_MS` = 5s, `Infinity` disables) with a `MutationTimeoutError` on timeout, ignores stale in-flight callbacks via a mutation id, and `reset()` clears state. `mutate` accepts a trailing `MutationCallOptions` (`{timeout?, throwOnTimeout?, throwOnError?}`) per call that overrides the composable options; `throwOnTimeout`/`throwOnError` (global or per call, default `false`) make the call's tracked promise reject on timeout / error details instead of just reporting via `error`.
- `src/vue-view.ts` — `VueView` class (produced by the exported `vueViewFactory`) implementing Zero's `Output` view contract: reads `input.fetch()`, applies `push()` changes, flushes on transaction commit, and resolves `queryComplete` into `status`/`error`. Exposes reactive `data`/`status`/`error` refs plus `updateTTL(ttl)`/`destroy()`. Also defines the public `QueryStatus`/`QueryError` types.
- `src/connection-state.ts` — `useConnectionState(zero)` → `Ref<ConnectionState>`; reactively watches a `MaybeRefOrGetter<Zero>`, subscribing to `connection.state` and tearing down/re-subscribing on swap. Unsubscribes on unmount.
- `src/create-bindings.ts` — `createBindings(zero, { queries?, mutators? })` returns `{useQuery, useMutation, useConnectionState, useZero}` with a shared reactive zero (`computed(() => toValue(zero))`) pre-bound, so the zero is passed once per app. The `queries`/`mutators` registries (from `defineQueries`/`defineMutators`) are injected into the bound callbacks; the mutator registry must be the same one passed to the `Zero` constructor. Bound `useConnectionState`/`useZero` expose the shared zero's connection state and value. Swapping a reactive zero tears down and re-materializes all bound views.

## Key Directories

| Path           | Purpose                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `src/`         | Library source; public API lives here                                                          |
| `test/`        | Vitest unit tests (`*.test.ts`)                                                                |
| `.playground/` | Demo app (workspace package `@zero-vue/playground`) exercising the API against an offline Zero |
| `coverage/`    | Test coverage output (generated)                                                               |

## Development Commands

Run via **pnpm** at repo root:

```bash
pnpm test             # run tests once (vp test run)
pnpm test:watch       # watch mode (vp test)
pnpm check-types      # vue-tsc --noEmit typecheck
pnpm lint             # lint with oxc (vp lint)
pnpm format           # format with oxc (vp fmt)
pnpm playground       # run the demo app (pnpm --filter @zero-vue/playground dev)
pnpm check:playground # typecheck the playground (vue-tsc)
```

`vite-plus` (aliased `vp`) is the unified build/test runner (wrapper over Vite + Vitest + oxlint). There is no separate build step — no `build` script exists; tests/typecheck are the verification path.

## Code Conventions & Common Patterns

- **Runtime/build:** ESM only (`"type": "module"`), TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`). `moduleResolution: "bundler"`.
- **Import convention:** Local imports use explicit `.ts` extensions (`import {useQuery} from './query.ts'`). `allowImportingTsExtensions` is on.
- **Zero types:** Always import Zero types/values directly from `@rocicorp/zero`, never through a re-export shim.
- **Vue reactivity:** `shallowRef` for data payloads (avoid deep reactivity on large query results), `ref` for scalar status, `computed` for derived zero/options/ttl and for the read-only `data`/`status`/`error` surface, `watch` for query lifecycle, `toValue` to normalize `MaybeRefOrGetter`. VueView swaps its `shallowRef` wholesale on each flush.
- **Composable signature:** `zero` and `options` accept `MaybeRefOrGetter`; `querySignal` is a **getter function** `() => QueryOrQueryRequest | Falsy` (falsy disables the query → `undefined` data / `'disabled'` status). `useMutation`'s `mutationFn` is `(...args) => MutateRequest` — it returns a `MutateRequest` from a registered custom mutator (the bound form injects `mutators`, so `({ mutators }, ...args) => mutators.x(...)`); the composable executes it via `zero.mutate(request)` and legacy CRUD (`zero.mutate.item.*`) is not supported through the callback. `args` must be explicitly annotated for TS to infer the `mutate` tuple type.
- **TTL:** queries default to `DEFAULT_TTL_MS` (5 min); overridable via `UseQueryOptions.ttl` or `VueView.updateTTL`. Tests use e.g. `'10m'`.
- **Error handling:** `useQuery` exposes completeness via `status` (`'complete' | 'unknown' | 'error'`, plus `'disabled'` when the query is off) and the error payload via `error` (a `QueryError` with `{retry, type, message, details?}`, or `undefined` when not errored; `retry` re-materializes by bumping `refetchKey`). `VueView` resolves Zero's `queryComplete` signal (`true | ErroredQuery | Promise<true>`) into its `status`/`error` refs; `useQuery` maps those to the public `QueryStatus`/`QueryError` shapes and adds `retry`/`'disabled'`.
- **State management:** No external store. State lives in Zero (client-side, offline-first) and flows through the composables into Vue refs. `createBindings` shares one reactive Zero across all bound queries.

## Important Files

| File                      | Why it matters                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/index.ts`            | Package entry (exports map `.` → `./src/index.ts`)                                              |
| `src/query.ts`            | Core query composable; primary public read API                                                  |
| `src/mutation.ts`         | Core mutation composable (`useMutation`); timeout race + `isPending`/`error` tracking           |
| `src/vue-view.ts`         | `VueView` factory view + `vueViewFactory`; IVM view lifecycle + reactivity                      |
| `package.json`            | Scripts, exports map, peer `vue ^3.5`, dep `@rocicorp/zero ^1.8.0`                              |
| `pnpm-workspace.yaml`     | Workspace (`packages: [.playground]`), catalog + overrides for vite/vitest/vite-plus            |
| `tsconfig.json`           | TS strictness, `allowImportingTsExtensions`, `types: ["vitest/globals"]`                        |
| `vitest.config.ts`        | `environment: 'jsdom'`, `include: ['test/**/*.test.ts']`                                        |
| `vite.config.ts`          | vite-plus config: `fmt`, `lint` (oxlint plugin, `vite-plus/prefer-vite-plus-imports` error)     |
| `.playground/bindings.ts` | Canonical usage: `new Zero({server: null, mutators, ...})` + `createBindings(zero, {mutators})` |

## Runtime/Tooling Preferences

- **Runtime:** Node (browser-targeted library; jsdom for tests).
- **Package manager:** **pnpm 11.21.0** (enforced via `devEngines.packageManager`; auto-download on mismatch).
- **Workspace:** pnpm monorepo with a single `@zero-vue/playground` package. `catalog:` + `overrides:` pin `vite`/`vitest`/`vite-plus` (via `@voidzero-dev/vite-plus-core`).
- **Build/test runner:** `vite-plus` (the `vp` binary) — used for test, lint, format, dev.
- **Linting:** ESLint + the `vite-plus/oxlint-plugin` (type-aware); rule `vite-plus/prefer-vite-plus-imports: error` enforces importing vite-plus instead of raw vite/vitest.
- **Formatting:** Prettier (`pnpm format` targets `src/`).
- No CI config, no eslint/prettier config files, no `scripts/` dir, no README present.

## Testing & QA

- **Framework:** Vitest 4 via `vite-plus`, **jsdom** environment, `test/**/*.test.ts`. Globals are declared in tsconfig types but each test file imports `describe`/`expect`/`test` from `vite-plus/test`.
- **Running:** `pnpm test` (once) / `pnpm test:watch`. Coverage via `@vitest/coverage-v8` + `@vitest/ui` (output in `coverage/`).
- **Pattern — real Zero, no mocks:** Zero is **not** faked/stubbed. Tests construct a real client with `new Zero({server: null, userID: 'test', schema, kvStore: 'mem'})` and write data via `await z.mutate.item.insert({...})` or registry mutators (`new Zero({..., mutators})` + `z.mutate(registry.x(...))`). With `server: null`, sync never completes, so `status` stays `'unknown'` and `MutatorResult.server` promises never settle (documented behavior). A small shared schema is defined per file: `createSchema({ tables: [table('item').columns({id: number(), name: string()}).primaryKey('id')], enableLegacyMutators: true })`.
- **Vue reactivity:** driven with `nextTick`; `@vue/test-utils` `mount` is used only in `connection-state.test.ts` (via `defineComponent` + `watchEffect`). No fake timers, no setup files.
- **Assertions:** deep-compare query rows via a `rows = (d) => JSON.parse(JSON.stringify(d))` helper (strips `Symbol(rc)` row-context symbols); `toMatchInlineSnapshot` for snapshots.
- **What's covered:** `VueView` via `z.materialize(query, vueViewFactory)` (initial state, reactive updates, `destroy()` stops updates, TTL, singular `.one()` vs plural, empty singular → `undefined`); `useQuery`/`createBindings` (row delivery, reactive re-materialization on swapped reactive zero, falsy/disabled → `'disabled'` status); `useMutation`/bound `useMutation` (isPending transitions, resolved-error-details vs timeout-rejection error surfacing, timeout race → `MutationTimeoutError`, `reset()`, registry injection, type-level rejection of unbound `ctx.mutators`); `useConnectionState` (state ref after mount).
