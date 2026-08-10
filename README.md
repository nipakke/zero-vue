# @nipakke/zero-vue

Thin Vue 3 reactivity adapter over the [Zero](https://zero.rocicorp.dev/) sync engine. Wraps Zero's materialized views and connection state as Vue reactive state, so a Vue app can query local, offline-first data declaratively.

- `useQuery` — turn a query signal into reactive `data` / `error` / `status`
- `createBindings` — bind a Zero instance once, share it across every query
- `useConnectionState` — reactive connection status
- `VueView` — the materialized-view wrapper underneath

## Requirements

`vue` and `@rocicorp/zero` are **peer dependencies** — you install them yourself:

| Package | Version |
|---|---|
| `vue` | `^3.3.0` |
| `@rocicorp/zero` | `>=1.7.0 <1.9.0` |

The published package ships ESM + CJS with type declarations (`dist/`), and is `sideEffects: false` for tree-shaking.

## Installation

```bash
pnpm add @nipakke/zero-vue @rocicorp/zero vue
# npm i @nipakke/zero-vue @rocicorp/zero vue
```

## Quick start

```ts
// zero.ts
import { Zero, createSchema, table, string, number, boolean } from "@rocicorp/zero";
import { createBindings } from "@nipakke/zero-vue";

const schema = createSchema({
  tables: [
    table("item")
      .columns({
        id: number(),
        title: string(),
        done: boolean(),
        createdAt: number(),
      })
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
export const { query } = createBindings(zero);
```

```vue
<script setup lang="ts">
import { ref } from "vue";
import { createBuilder } from "@rocicorp/zero";
import { query, zero, schema } from "./zero.ts";

const doneOnly = ref(false);
const ttl = ref<number | undefined>(undefined);

// Every ref read inside the signal re-evaluates and re-materializes the view.
const { data: items, status, error } = query(() => {
  let q = createBuilder(schema).item;
  if (doneOnly.value) q = q.where("done", true);
  return q.orderBy("createdAt", "desc");
}, () => ({ ttl: ttl.value }));

const addItem = async () => {
  await zero.mutate.item.insert({ id: Date.now(), title: "todo", done: false, createdAt: Date.now() });
};
</script>

<template>
  <p>Status: {{ status }}</p>
  <ul>
    <li v-for="item in items ?? []" :key="item.id">{{ item.title }}</li>
  </ul>
</template>
```

## API

### `useQuery(zero, querySignal, options?)`

```ts
const { data, error, status } = useQuery(zero, () => createBuilder(schema).item);
```

- `zero` — a `Zero` instance, `ref`, or getter (`MaybeRefOrGetter`). Reactive zeros are watched: swapping the instance tears down every view and re-materializes against the new one.
- `querySignal` — a getter returning a Zero `Query` (or query request). Return a falsy value to disable the query: `data` becomes `undefined` and `status` becomes `"disabled"`.
- `options` — `{ ttl?: TTL }` or a getter for it. Default TTL is 5 minutes (`DEFAULT_TTL_MS`).
- Returns `{ data, error, status }` where:
  - `data` — `ComputedRef` of the query rows (or `undefined` on the falsy/disabled path)
  - `status` — `"complete" | "unknown" | "error" | "disabled"`
  - `error` — `undefined`, or `{ error, retry, refetch }` with a re-materializing callback

Views are created on mount and torn down on unmount (or when the query hash / zero / TTL changes).

### `createBindings(zero)`

```ts
const { query } = createBindings(zero);
// query(querySignal, options?) === useQuery(zero, querySignal, options?)
```

Call once per app. All returned `query` calls share one reactive zero, so the zero is passed once instead of on every call.

### `useConnectionState(zero)`

```ts
import { useConnectionState } from "@nipakke/zero-vue";

const state = useConnectionState(zero); // Ref<ConnectionState>
```

Reactive `ConnectionState` from `zero.connection.state`, subscribing on mount and unsubscribing on unmount. The zero is resolved reactively — swapping it re-subscribes to the new instance.

### `VueView`

The materialized-view wrapper used internally by the composables. Useful if you need the view lifecycle directly:

```ts
import { VueView } from "@nipakke/zero-vue";
```

## Development

```bash
pnpm install
pnpm test          # unit tests
pnpm check-types   # library typecheck
pnpm build         # dist/ (ESM + CJS + d.ts), with publint + attw gates
pnpm playground    # run the demo app
```

## Releasing

Versioning is managed by pnpm's built-in release tooling ([docs](https://pnpm.io/versioning)):

```bash
pnpm change                 # record a change intent (.changeset/*.md)
pnpm change status          # preview pending intents
pnpm version -r             # consume intents: bump versions, write changelogs
pnpm publish -r             # publish the bumped workspace
```

The playground (`@zero-vue/playground`) is ignored via `versioning.ignore` in `pnpm-workspace.yaml` — it is private and never versioned or published. First releases publish the manifest version verbatim; recorded intents apply from the next release.

## License

MIT
