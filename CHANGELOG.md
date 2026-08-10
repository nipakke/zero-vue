# @nipakke/zero-vue

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
