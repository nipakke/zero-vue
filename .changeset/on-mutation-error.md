---
"@nipakke/zero-vue": minor
---

Add `onMutationError` observers for mutation failures, at both levels:

- `useMutation(zero, mutationFn, { onMutationError })` — fires whenever a mutation fails, receiving the same branded `Error` that is set as the composable's `error` ref: `MutationTimeoutError` when the tracked promise exceeded `timeout`, `MutationError` when the mutation itself failed. It is a pure observer — it fires regardless of `throwOnTimeout`/`throwOnError` and does not change what `mutate` returns or what `error` holds.
- `createBindings(zero, { onMutationError })` — app-wide observer for every bound mutation's failure (analytics, logging); fires after the per-composable callback, if any.

Mutation failures are now branded as a new exported `MutationError` (subclass of `Error`): the `error` ref and the promise `mutate` rejects with both carry it, and `cause` holds Zero's raw error details (`{type: 'app' | 'zero', message, details?}`) when the failure was normalized into resolved details. Check `error instanceof MutationError` vs `error instanceof MutationTimeoutError` to tell mutation failures apart from timeouts.
