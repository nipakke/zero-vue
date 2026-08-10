---
"@nipakke/zero-vue": minor
---

⚠️ **Possible breaking change:** `useMutation`'s `throwOnError` now defaults to `true`. The promise returned by `mutate` rejects when the mutation itself fails (resolved with error details, e.g. a custom mutator that throws), instead of resolving with the error details — so `await mutate(...)` now throws on mutation errors. The failure is still also reported via the `error` ref. Pass `throwOnError: false` (globally via `UseMutationOptions` or per call via `MutationCallOptions`) to restore the old resolve-with-details behavior. `throwOnTimeout` still defaults to `false`.
