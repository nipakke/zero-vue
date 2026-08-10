# @nipakke/zero-vue

A Vue 3 wrapper around [Zero](https://zero.rocicorp.dev/) — query local, offline-first data reactively.

`useQuery` turns a query signal into reactive `data` / `error` / `status`. `createBindings` binds a Zero instance once and shares it across every query. `useConnectionState` exposes connection status.

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

const { data: items, status, error } = useQuery(() => {
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

## API

- `useQuery(zero, querySignal, options?)` → `{ data, error, status }`. `zero` may be a `Zero`, `ref`, or getter; `querySignal` is a getter returning a `Query` (a falsy value disables the query → `data: undefined`, `status: "disabled"`); `options` is `{ ttl?: TTL }` or a getter (default 5 min). `status` is `"complete" | "unknown" | "error" | "disabled"`.
- `createBindings(zero)` → `{ useQuery }` where `useQuery(querySignal, options?) === useQuery(zero, querySignal, options?)`. Call once per app.
- `createBindings(zero, { queries })` — optionally pass a `queries` registry (from `defineQueries`) to enable the registry getter form: `useQuery((queries) => queries.allItems())`. When no registry is passed, `useQuery` only takes the zero-argument signal.
- `useConnectionState(zero)` → `Ref<ConnectionState>` from `zero.connection.state`, subscribed on mount and unsubscribed on unmount.

## License

MIT
