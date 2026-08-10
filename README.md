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
export const { query } = createBindings(zero);
```

```vue
<script setup lang="ts">
import { ref } from "vue";
import { createBuilder } from "@rocicorp/zero";
import { query, zero, schema } from "./zero.ts";

const doneOnly = ref(false);

// Build the base query once; chaining returns a new builder each time.
const base = createBuilder(schema).item;

const { data: items, status, error } = query(() => {
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

## API

- `useQuery(zero, querySignal, options?)` → `{ data, error, status }`. `zero` may be a `Zero`, `ref`, or getter; `querySignal` is a getter returning a `Query` (a falsy value disables the query → `data: undefined`, `status: "disabled"`); `options` is `{ ttl?: TTL }` or a getter (default 5 min). `status` is `"complete" | "unknown" | "error" | "disabled"`.
- `createBindings(zero)` → `{ query }` where `query(querySignal, options?) === useQuery(zero, querySignal, options?)`. Call once per app.
- `useConnectionState(zero)` → `Ref<ConnectionState>` from `zero.connection.state`, subscribed on mount and unsubscribed on unmount.

## License

MIT
