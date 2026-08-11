---
"@nipakke/zero-vue": minor
---

**Breaking:** reworked `useMutator`'s tracking and dropped `awaitMode`, `throwOnError`, and `throwOnTimeout`.

`mutate` now returns the raw `{ client, server }` `MutatorResult` (Zero normalizes both promises to resolve with `MutatorResultDetails`, so neither rejects under normal operation), and the composable tracks **both** legs. The result gains per-leg status:

```ts
const { mutate, isPending, error, client, server, reset } = useMutator(
  zero,
  () => mutators.addItem,
);
// isPending: Ref<boolean>             — true while either leg is in flight
// error:     Ref<Error | null>        — first failure across both legs
// client / server: { isPending: Ref<boolean>, error: Ref<Error | null> }
```

`onError`, `onSuccess`, and `onSettled` (and the `createBindings`-level `onMutationError` / `onMutationSuccess` / `onMutationSettled`) now receive a `kind: 'client' | 'server'` naming which leg settled, so the server's outcome is reported instead of hidden.

`awaitMode`, `throwOnError`, and `throwOnTimeout` are removed. App failures are surfaced via the resolved error-details on the relevant leg's `error` ref and the observers (`MutationError`); a leg that exceeds `timeout` reports a `MutationTimeoutError` on that leg.

When there is no **live server** — none configured (`zero.server === null`) or the app is offline — the server leg is never awaited: `mutate().server` is the _same_ promise as `mutate().client`, `server` mirrors `client`, and observers fire with `kind: 'client'` only (an offline/serverless server promise can never settle, so awaiting it would hang). A live, connected server's leg is tracked separately and reports its own outcome (and timeout).
