# @nipakke/zero-vue

A Vue 3 wrapper around [Zero](https://zero.rocicorp.dev/) — query local, offline-first data reactively.

`useQuery` turns a query signal into reactive `data` / `error` / `status`. `useMutation` runs registered Zero mutators with `isPending` / `error` tracking. `createBindings` binds a Zero instance once and shares it across every query and mutation. `useConnectionState` exposes connection status.

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

Zero runs the mutators you pass to the `Zero` constructor. `useMutation` takes a callback that returns a `MutateRequest` from one of those mutators, executes it against the zero, and tracks the result.

Use the standalone composable and close over your own registry:

```ts
import { defineMutators } from "@rocicorp/zero";
import { useMutation } from "@nipakke/zero-vue";

// Registry of mutators (same shape as `new Zero({ mutators, ... })`).
const mutators = defineMutators(schema, {
  addItem: (tx, item: { id: number; title: string; done: boolean }) => tx.item.insert(item),
});

const { mutate, isPending, error } = useMutation(zero, (item) => mutators.addItem(item));
```

Or pass the same registry to `createBindings` — the bound `useMutation` injects it into the callback as `{ mutators }`, so the zero and registry are each passed once:

```ts
// zero.ts
export const zero = new Zero({ server: null, userID: "user-1", schema, mutators, kvStore: "idb" });
export const { useQuery, useMutation } = createBindings(zero, { queries, mutators });
```

```vue
<script setup lang="ts">
import { useMutation } from "./zero.ts";

const { mutate, isPending, error } = useMutation(({ mutators }, item) => mutators.addItem(item));

async function add(title: string) {
  await mutate({ id: Date.now(), title, done: false });
}
</script>
```

The mutators registry passed to `createBindings` must be the **same** one given to `new Zero({ mutators })` — Zero executes the mutators it was constructed with; the bindings registry only supplies the typed callback surface. Without a mutators registry, the callback's `mutators` is `never`, so you must return a `MutateRequest` from a registry you hold yourself: `useMutation((_, item) => myMutators.addItem(item))`.

`mutate(...args, options?)` resolves with the `MutatorResult` (`{ client, server }`); by default it tracks the `client` promise. `isPending` is `true` while the tracked promise is in flight, and `error` holds the failure (a `MutationTimeoutError` if it exceeded the timeout). `reset()` clears the error and pending state.

By default `mutate` **throws on mutation errors**: if the mutation itself fails (e.g. a custom mutator throws), the returned promise rejects, so `await mutate(...)` throws and the same error is also reported via the `error` ref. Pass `throwOnError: false` (globally or per call) to have the call resolve with the error details instead of rejecting.

## API

- `useQuery(zero, querySignal, options?)` → `{ data, error, status }`. `zero` may be a `Zero`, `ref`, or getter; `querySignal` is a getter returning a `Query` (a falsy value disables the query → `data: undefined`, `status: "disabled"`); `options` is `{ ttl?: TTL }` or a getter (default 5 min). `status` is `"complete" | "unknown" | "error" | "disabled"`.
- `useMutation(zero, mutationFn, options?)` → `{ mutate, isPending, error, reset }`. `mutationFn(...args)` returns a `MutateRequest` from a registered custom mutator; `mutate(...args, options?)` executes it against the current zero and returns the `MutatorResult`. `options` is `{ awaitMode?: "client" | "server", timeout?: number, throwOnTimeout?: boolean, throwOnError?: boolean }` (timeout defaults to 5s; `Infinity` disables it; `throwOnError` defaults to `true` — the call's promise rejects when the mutation fails; `throwOnTimeout` defaults to `false`). Each `mutate` call may override options by passing a trailing `MutationCallOptions` object — a trailing argument counts as call options only when it consists solely of those option keys with matching value types, so payloads that merely contain a `timeout`-named field (or carry option names with other value types) pass through to the mutator untouched.
- `createBindings(zero)` → `{ useQuery, useMutation, useConnectionState, useZero }`, all bound to the shared reactive zero. Call once per app.
- `createBindings(zero, { queries })` — pass a `queries` registry (from `defineQueries`) to enable the registry getter form: `useQuery((queries) => queries.allItems())`. When no registry is passed, `useQuery` only takes the zero-argument signal.
- `createBindings(zero, { mutators })` — pass a `mutators` registry (from `defineMutators`) to inject it into the bound mutation callback: `useMutation(({ mutators }, item) => mutators.addItem(item))`. The registry must be the same one passed to `new Zero({ mutators })`; without it, the callback's `mutators` is `never`.
- Bound `useConnectionState()` → `Ref<ConnectionState>`, the `useConnectionState` composable pre-bound to the shared zero (no arguments).
- Bound `useZero()` → `ComputedRef<Zero>`, the shared reactive zero itself for direct access.
- `useConnectionState(zero)` → `Ref<ConnectionState>` from `zero.connection.state`, subscribed on mount and unsubscribed on unmount.

## License

MIT
