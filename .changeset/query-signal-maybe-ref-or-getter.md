---
"@nipakke/zero-vue": minor
---

`useQuery`'s `querySignal` now accepts a `MaybeRefOrGetter<Query>` instead of being getter-only, matching how `zero` and `options` already accept refs/getters. `useQuery(zero, queryRef)` and `useQuery(zero, query)` both work without a wrapper; a falsy value still disables the query (`data: undefined`, `status: "disabled"`). A `ref` holding the query is deep-reactivated by Vue, so `useQuery` strips the reactive Proxy via `toRaw` before materializing.
