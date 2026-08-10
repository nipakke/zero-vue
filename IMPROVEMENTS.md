# Improvement Ideas — @nipakke/zero-vue

Brainstormed 2026-08-10. Grounded in the current source (`src/`, `test/`, CI workflows). The project is already mature (query + mutation + bindings + connection-state, changesets, lint/typecheck/pack gates, real-Zero tests). Grouped roughly by value.

## High-value feature gaps

1. **`useQuery` has no `select`/`transform` option.** It returns raw `HumanReadable<TReturn>` rows. A `select?: (data) => projected` option (TanStack-style) would let consumers shape data without re-materializing — e.g. `useQuery(..., { select: rows => rows.map(pick) })`. Cheap, non-breaking, and slots into the existing `computed(() => view.value?.data.value)` surface in `src/query.ts`.

2. **No pagination / infinite-query support.** Zero's `Query` has `.limit()`, `.related()`, and prefetch/deferred queries — none of which the adapter wraps. Large local datasets (a primary use case for offline-first) want `usePaginatedQuery` or a `useInfiniteQuery` that chains `.limit(offset+size)`. This is the single biggest missing "database adapter" feature.

3. **No optimistic-update ergonomics.** Zero already supports optimistic mutators, but there's no Vue-side helper for "apply locally, roll back on error." A `useOptimistic`/mutation-callback hook that snapshots prior rows and reverts on `MutationError` would be a strong differentiator vs. raw Zero.

4. **`isLoading`/`isFetching` derived states.** `status` covers `complete/unknown/error/disabled`, but no convenience flags. A `computed` `isFetching = status === "unknown" && !disabled` (or `isLoading` = `data === undefined && status !== "disabled"`) would remove a common boilerplate check.

## Correctness / design risks worth revisiting

5. **`isMutationCallOptions` heuristic is a footgun** (`src/mutation.ts`). It swallows a payload that legitimately carries `{ timeout: <number> }` — e.g. a `mutators.updateUser({ timeout: 60 })` mutation arg would be mis-split as call options, because it matches every-key-in-`{"timeout","throwOnTimeout","throwOnError"}` + correct types. Consider an explicit escape hatch (a wrapper/`{ options }` marker) or at minimum a JSDoc warning + a test documenting this exact collision. Worth calling out before v1.0.

6. **`awaitMode: "server"` + `server: null` hangs to timeout by design** — documented, but consider surfacing it: a console warning when `awaitMode === "server"` and the zero has no server, or a distinct `MutationTimeoutError` message naming the no-server case.

## DX / tooling

7. **`querySignal` is getter-only** (`() => Query`). Accepting `MaybeRefOrGetter<Query>` directly would let `useQuery(refQuery)` work without the wrapper — ergonomic and consistent with how `zero`/`options` already accept `MaybeRefOrGetter`.

8. **No committed eslint/prettier config** (AGENTS.md confirms none exist) — linting is entirely oxc-via-vite-plus defaults. Committing a pinned `oxlint`/`prettier` config would make formatting reproducible for contributors and CI.

9. **Docs:** README is strong but has no `VueView`/`materialize` reference, no `awaitMode: "server"` or TTL-update example, and no `useZero`/`useConnectionState` bound-form snippet. A small "Advanced / API reference" section (or JSDoc-driven API page) would round it out.

## Testing gaps

10. **Untested paths** (easy wins, all use the existing real-Zero harness):
    - `useQuery` `retry` re-materialization (`refetchKey` bump) and the `options`-as-getter form.
    - `onMutationError` ordering: per-composable fires before bindings-level compose (the CHANGELOG claims this; `mutation.test.ts` doesn't cover the compose order).
    - `useZero` bound composable; `VueView.updateTTL` already covered in `vue-view.test.ts`.

11. **CI could gate coverage.** `@vitest/coverage-v8` + `@vitest/ui` are installed and coverage output exists, but `ci.yml` doesn't run coverage or enforce a threshold. Add `coverage` to CI with a modest floor to prevent regressions.

## Nits

- `peerDependencies` pins `@rocicorp/zero` to `<1.9.0` — worth bumping/widening as Zero ships newer releases (currently `^1.8.0`).
- `MutationResult.mutate` returns a fire-and-forget `MutatorResult`; a `mutate` variant that returns the tracked `Promise<MutatorResultDetails>` directly would be a nicer `await` ergonomics for callers who don't want the `{client, server}` shape.

---

Suggested starting points: **#1 (select option)** and **#7 (MaybeRefOrGetter querySignal)** as small, non-breaking, testable additions, then **#10** to lock in the untested paths.
