# @nipakke/zero-vue

A Vue 3 wrapper around [Zero](https://zero.rocicorp.dev/) — query local, offline-first data reactively.

`useQuery` turns a query signal into reactive `data` / `error` / `status`. `useMutator` runs registered Zero mutators with `isPending` / `error` tracking. `createBindings` binds a Zero instance once and shares it across every query and mutation. `useConnectionState` exposes connection status.

> **Before 1.0:** the API is still stabilizing — breaking changes can ship in any minor version without a major bump. Watch the [changelog](./CHANGELOG.md) and release notes for breaking changes as you upgrade.

## Install

```bash
pnpm add @nipakke/zero-vue @rocicorp/zero vue
```

`vue` (`^3.3.0`) and `@rocicorp/zero` (`>=1.7.0 <1.9.0`) are peer dependencies.

## Example

```ts
// zero.ts
import { Zero, createSchema, table, string, number, boolean } from "@rocicorp/zero";
import { createBindings } from "@nipakke/zero-vue";

const schema = createSchema({
  tables: [
    table("item")
      .columns({ id: number(), title: string(), done: boolean(), createdAt: number() })
      .primaryKey("id"),
  ],
  enableLegacyMutators: true,
});

export const zero = new Zero({
  server: null, // offline only — point at your sync server for real sync
  userID: "user-1",
  schema,
  kvStore: "idb",
});

// Bind the zero once; every query shares it.
// createBindings also accepts a getter: createBindings(() => zero)
export const { useQuery } = createBindings(zero);
```

```vue
<script setup lang="ts">
import { ref } from "vue";
import { createBuilder } from "@rocicorp/zero";
import { useQuery, zero, schema } from "./zero.ts";

const doneOnly = ref(false);

// Build the base query once; chaining returns a new builder each time.
const base = createBuilder(schema).item;

const {
  data: items,
  status,
  error,
} = useQuery(() => {
  let q = base;
  if (doneOnly.value) q = q.where("done", true);
  return q.orderBy("createdAt", "desc");
});
</script>

<template>
  <p>Status: {{ status }}</p>
  <ul>
    <li v-for="item in items ?? []" :key="item.id">{{ item.title }}</li>
  </ul>
</template>
```

## Named queries (`defineQueries`)

Pass a `queries` registry (from Zero's `defineQueries`) to `createBindings` to query through named, reusable queries. The registry getter is available on the returned `useQuery` only when a registry was passed.

```ts
import { createBuilder, defineQuery, defineQueries } from "@rocicorp/zero";
import { createBindings } from "@nipakke/zero-vue";

const zql = createBuilder(schema);

// Define reusable, named queries against the schema.
const queries = defineQueries({
  all: defineQuery(() => zql.item),
  open: defineQuery(() => zql.item.where("done", false).orderBy("createdAt", "desc")),
});

// Bind the zero once and pass the registry.
export const { useQuery } = createBindings(zero, { queries });
```

```vue
<script setup lang="ts">
import { useQuery } from "./zero.ts";

// The registry is available as the getter argument.
const { data: openItems, status } = useQuery((q) => q.open());
</script>
```

## Mutations (`defineMutators`)

Zero runs the mutators you pass to the `Zero` constructor. `useMutator` takes a getter that returns one of those mutators — a reference, not a call — executes it against the zero, and tracks the result. Because the getter returns the mutator itself, the mutator's argument type is inferred onto `mutate`.

Use the standalone composable and close over your own registry:

```ts
import { defineMutators } from "@rocicorp/zero";
import { useMutator } from "@nipakke/zero-vue";

// Registry of mutators (same shape as `new Zero({ mutators, ... })`).
const mutators = defineMutators(schema, {
  addItem: (tx, item: { id: number; title: string; done: boolean }) => tx.item.insert(item),
});

// `mutate` takes `{ id, title, done }` — inferred from `mutators.addItem`.
const { mutate, isPending, error } = useMutator(zero, () => mutators.addItem);
```

Or pass the same registry to `createBindings` — the bound `useMutator` injects it into the getter, so the zero and registry are each passed once:

```ts
// zero.ts
export const zero = new Zero({ server: null, userID: "user-1", schema, mutators, kvStore: "idb" });
export const { useQuery, useMutator } = createBindings(zero, { queries, mutators });
```

```vue
<script setup lang="ts">
import { useMutator } from "./zero.ts";

// `mutators` is the bound registry; `mutate` takes `addItem`'s argument type.
const { mutate, isPending, error } = useMutator((mutators) => mutators.addItem);

async function add(title: string) {
  await mutate({ id: Date.now(), title, done: false });
}
</script>
```

The mutators registry passed to `createBindings` must be the **same** one given to `new Zero({ mutators })` — Zero executes the mutators it was constructed with; the bindings registry only supplies the typed callback surface. Without a mutators registry, the getter's parameter is `never`, so you must return a `Mutator` from a registry you hold yourself: `useMutator(() => myMutators.addItem)`.

`mutate(...args)` returns the `MutatorResult` (`{ client, server }`); Zero normalizes both promises to resolve with `MutatorResultDetails` (they never reject under normal operation), so `await mutate(...).client` gives you a narrowable `{type:'success' | 'error'}` outcome. The composable tracks **both legs**: `isPending` is `true` while either is in flight, `error` holds the first failure, and `client`/`server` give per-leg `isPending`/`error`. Every observer receives a `kind` telling you which leg settled — so you see exactly what's happening on each side instead of the server's outcome being hidden. `reset()` clears the error and pending state on both legs.

When there is no **live server** — none configured (`zero.server === null`) or the app is offline — the server leg is never awaited: `mutate().server` is the _same_ promise as `mutate().client`, `server` mirrors `client`, and observers fire with `kind: 'client'` only. This is deliberate: an offline/serverless server promise can never settle, so awaiting it would hang. When a server is live and connected, the server leg is tracked against the real backend and reports its own outcome (and timeout).

Each awaited leg races `options.timeout` (default 5s); on timeout that leg's `isPending` flips to `false` and its `error` becomes a `MutationTimeoutError`. App failures surface as `MutationError` on the resolved `error` details.

Every failure — timeout or app error, on either leg — fires the `onError` observer (`options.onError`, and/or the `createBindings`-level `onMutationError` for bound composables; local fires first, then global). It receives a `{ error, args, mutatorName, kind }` object: the same branded error that lands on that leg's `error` ref — `instanceof MutationTimeoutError` vs `instanceof MutationError` tells the kinds apart — plus the mutator's arguments object, name, and which leg settled. `onSuccess` fires when a leg succeeds (with `{ args, mutatorName, kind }`), and `onSettled` fires on every settle (success or failure) with `{ args, error?, mutatorName, kind }` (`error` is `undefined` on success):

```ts
import { MutationTimeoutError, MutationError } from "@nipakke/zero-vue";

useMutator(zero, () => mutators.addItem, {
  onError({ error, args, mutatorName, kind }) {
    if (error instanceof MutationTimeoutError) {
      analytics.track("mutation_timeout", { message: error.message, args, mutatorName, kind });
    } else if (error instanceof MutationError) {
      analytics.track("mutation_error", {
        message: error.message,
        args,
        mutatorName,
        kind,
        cause: error.cause, // Zero's raw {type: "app" | "zero", message, details?}
      });
    }
  },
  onSuccess({ args, mutatorName }) {
    // the write was applied
  },
  onSettled({ args, error, mutatorName }) {
    // teardown/logging on both paths; error is undefined on success
  },
});
```

The observer is a pure listener: it fires regardless of `throwOnTimeout`/`throwOnError`, does not change what `mutate` returns, and the failure is always also in `error`. Use the `createBindings`-level callback for app-wide analytics/logging and the per-composable one for local handling.

## API

- `useQuery(zero, querySignal, options?)` → `{ data, error, status }`. `zero` and `querySignal` accept a `MaybeRefOrGetter` (a `Query`, `ref`, or getter — so `useQuery(zero, queryRef)` and `useQuery(zero, () => myQuery())` both work); a falsy value disables the query → `data: undefined`, `status: "disabled"`; `options` is `{ ttl?: TTL }` or a getter (default 5 min). `status` is `"complete" | "unknown" | "error" | "disabled"`.
- `useMutator(zero, mutatorGetter, options?)` → `{ mutate, isPending, error, client, server, reset }`. `mutatorGetter` returns a `Mutator` from a registered custom mutator — a reference, not a call (e.g. `() => mutators.addItem`); the selected mutator's argument type is inferred onto `mutate(...args)`, which executes it against the current zero and returns the `MutatorResult`. The composable tracks **both** the client and server legs: `isPending` is `true` while either is in flight, `error` holds the first failure, and `client`/`server` expose per-leg `isPending`/`error` (when there is no live server — none configured or offline — `server` mirrors `client` and `mutate().server` is the client promise). `options` is `{ timeout?: number, onError?: (info: { error: Error; args: TArgs; mutatorName: string; kind: 'client' | 'server' }) => void, onSuccess?: (info: { args: TArgs; mutatorName: string; kind: 'client' | 'server' }) => void, onSettled?: (info: { args: TArgs; error?: Error; mutatorName: string; kind: 'client' | 'server' }) => void }` (timeout defaults to 5s; `Infinity` disables it; `onError` observes every failure on either leg — `instanceof MutationTimeoutError` vs `instanceof MutationError` tells timeouts from app failures — `onSuccess` fires on success, and `onSettled` observes every settle with `error` `undefined` on success; each carries `kind` naming the leg). All options are set on `useMutator`, not per call — `mutate(...args)` takes only the mutator's arguments, so a payload that carries a `timeout`-named field is never mistaken for options.
- `createBindings(zero)` → `{ useQuery, useMutator, useConnectionState, useZero }`, all bound to the shared reactive zero. Call once per app.
- `createBindings(zero, { queries })` — pass a `queries` registry (from `defineQueries`) to enable the registry getter form: `useQuery((queries) => queries.allItems())`. When no registry is passed, `useQuery` only takes the zero-argument signal.
- `createBindings(zero, { mutators, onMutationError, onMutationSuccess, onMutationSettled })` — pass a `mutators` registry (from `defineMutators`) to inject it into the bound mutator getter: `useMutator((mutators) => mutators.addItem)`. The registry must be the same one passed to `new Zero({ mutators })`; without it, the getter's `mutators` parameter is `never`. The app-wide observers (`onMutationError`, `onMutationSuccess`, `onMutationSettled`) have the same shape and semantics as the per-composable ones (each receives `{ args, mutatorName }`, plus `error` on `onMutationError`/`onMutationSettled`), with `args` typed `unknown` because different bound mutators have different arg types. They fire for every bound mutation's settle, after the per-composable callback, if any — ideal for analytics and logging.
- Bound `useConnectionState()` → `Ref<ConnectionState>`, the `useConnectionState` composable pre-bound to the shared zero (no arguments).
- Bound `useZero()` → `ComputedRef<Zero>`, the shared reactive zero itself for direct access.
- `useConnectionState(zero)` → `Ref<ConnectionState>` from `zero.connection.state`, subscribed on mount and unsubscribed on unmount.

## License

MIT
