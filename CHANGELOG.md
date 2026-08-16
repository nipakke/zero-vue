# @nipakke/zero-vue

## 0.3.1

### Patch Changes

- a21cbaf: Support @rocicorp/zero 1.9: widen the peer dependency range to `>=1.7.0 <1.10.0` and test against 1.9.0.

## 0.3.0

### Minor Changes

- ea27c80: `useQuery`'s `querySignal` now accepts a `MaybeRefOrGetter<Query>` instead of being getter-only, matching how `zero` and `options` already accept refs/getters. `useQuery(zero, queryRef)` and `useQuery(zero, query)` both work without a wrapper; a falsy value still disables the query (`data: undefined`, `status: "disabled"`). A `ref` holding the query is deep-reactivated by Vue, so `useQuery` strips the reactive Proxy via `toRaw` before materializing.
- ea27c80: **Breaking:** removed per-call `MutationCallOptions` from `mutate`. `timeout`, `throwOnTimeout`, and `throwOnError` are now composable-level only (`UseMutatorOptions`); `mutate(...args)` takes only the mutator's arguments. The trailing-options heuristic is gone, so a payload like `mutators.updateUser({ timeout: 60 })` is no longer mis-split.

  ```ts
  // Before — `{timeout: 60}` could be misread as call options
  mutate({ id: 1, timeout: 60 }, { throwOnError: false });

  // After — options live on `useMutator`; `mutate` takes only the payload
  const { mutate } = useMutator(zero, () => mutators.updateUser, {
    throwOnError: false,
  });
  mutate({ id: 1, timeout: 60 });
  ```

  **Breaking:** the mutation callbacks now take a single info object (never a tuple) carrying `args` (the mutator's arguments) and `mutatorName`, and `onMutationError` was replaced by three hooks:

  ```ts
  useMutator(zero, () => mutators.addItem, {
    onError: ({ error, args, mutatorName }) => {},
    onSuccess: ({ args, mutatorName }) => {},
    onSettled: ({ args, error, mutatorName }) => {}, // error undefined on success
  });
  ```

  `createBindings` gets the same app-wide hooks (`onMutationError`, `onMutationSuccess`, `onMutationSettled`) with `args: unknown`, replacing `onMutationError`'s old arg-less signature. Global observers fire after the per-composable ones, local first.

- ea27c80: **Breaking:** renamed `useMutation` to `useMutator` and changed the composable from a `mutationFn` that returns a `MutateRequest` to a getter that returns a `Mutator` reference (without calling it).

  `useMutation` is now `useMutator`, and `UseMutationOptions` is `UseMutatorOptions`. The second argument is a getter returning the selected mutator — the mutator's argument type is inferred onto the returned `mutate`, so the args are no longer declared by the caller:

  ```ts
  // Before
  const { mutate } = useMutation(zero, (item) => mutators.addItem(item));
  const { mutate } = useMutation(({ mutators }, item) =>
    mutators.addItem(item)
  );

  // After
  const { mutate } = useMutator(zero, () => mutators.addItem);
  const { mutate } = useMutator((mutators) => mutators.addItem);
  ```

  `mutate(...args)` behaves the same (`isPending`, `error`, `reset`, and `onError` are unchanged). The mutator getter is evaluated per `mutate` call and the zero is read at call time, so reactive zero/registry swaps are honored.

- ea27c80: **Breaking:** reworked `useMutator`'s tracking and dropped `awaitMode`, `throwOnError`, and `throwOnTimeout`.

  `mutate` now returns the raw `{ client, server }` `MutatorResult` (Zero normalizes both promises to resolve with `MutatorResultDetails`, so neither rejects under normal operation), and the composable tracks **both** legs. The result gains per-leg status:

  ```ts
  const { mutate, isPending, error, client, server, reset } = useMutator(
    zero,
    () => mutators.addItem
  );
  // isPending: Ref<boolean>             — true while either leg is in flight
  // error:     Ref<Error | null>        — first failure across both legs
  // client / server: { isPending: Ref<boolean>, error: Ref<Error | null> }
  ```

  `onError`, `onSuccess`, and `onSettled` (and the `createBindings`-level `onMutationError` / `onMutationSuccess` / `onMutationSettled`) now receive a `kind: 'client' | 'server'` naming which leg settled, so the server's outcome is reported instead of hidden.

  `awaitMode`, `throwOnError`, and `throwOnTimeout` are removed. App failures are surfaced via the resolved error-details on the relevant leg's `error` ref and the observers (`MutationError`); a leg that exceeds `timeout` reports a `MutationTimeoutError` on that leg.

  When there is no **live server** — none configured (`zero.server === null`) or the app is offline — the server leg is never awaited: `mutate().server` is the _same_ promise as `mutate().client`, `server` mirrors `client`, and observers fire with `kind: 'client'` only (an offline/serverless server promise can never settle, so awaiting it would hang). A live, connected server's leg is tracked separately and reports its own outcome (and timeout).

## 0.2.0

### Minor Changes

- dd180e1: Add `onMutationError` observers for mutation failures, at both levels:

  - `useMutation(zero, mutationFn, { onMutationError })` — fires whenever a mutation fails, receiving the same branded `Error` that is set as the composable's `error` ref: `MutationTimeoutError` when the tracked promise exceeded `timeout`, `MutationError` when the mutation itself failed. It is a pure observer — it fires regardless of `throwOnTimeout`/`throwOnError` and does not change what `mutate` returns or what `error` holds.
  - `createBindings(zero, { onMutationError })` — app-wide observer for every bound mutation's failure (analytics, logging); fires after the per-composable callback, if any.

  Mutation failures are now branded as a new exported `MutationError` (subclass of `Error`): the `error` ref and the promise `mutate` rejects with both carry it, and `cause` holds Zero's raw error details (`{type: 'app' | 'zero', message, details?}`) when the failure was normalized into resolved details. Check `error instanceof MutationError` vs `error instanceof MutationTimeoutError` to tell mutation failures apart from timeouts.

- dd180e1: ⚠️ **Possible breaking change:** `useMutation`'s `throwOnError` now defaults to `true`. The promise returned by `mutate` rejects when the mutation itself fails (resolved with error details, e.g. a custom mutator that throws), instead of resolving with the error details — so `await mutate(...)` now throws on mutation errors. The failure is still also reported via the `error` ref. Pass `throwOnError: false` (globally via `UseMutationOptions` or per call via `MutationCallOptions`) to restore the old resolve-with-details behavior. `throwOnTimeout` still defaults to `false`.

### Patch Changes

- dd180e1: `useQuery`: a query that cannot be hashed (for example a query object built against a different copy of Zero) now reports `status: 'error'` with the underlying message in `error`, instead of silently surfacing as `'disabled'`.
- dd180e1: `useQuery`, `useMutation`, and `useConnectionState` now register their cleanup on the active effect scope (`onScopeDispose`) instead of only inside components: used within an `effectScope` (e.g. a Pinia store), they now destroy views and unsubscribe when the scope stops. `useMutation` also clears in-flight timeout timers when the scope is disposed.
- dd180e1: `useMutation`: the trailing `mutate` argument is now treated as call options only when it consists solely of the option keys (`timeout`, `throwOnTimeout`, `throwOnError`) with matching value types. Payloads that merely contain a `timeout`-named field, or carry option names with other value types, are passed through to the mutation untouched instead of being silently consumed.

## 0.1.0

### Minor Changes

- createBindings now exposes bound useConnectionState and useZero composables
