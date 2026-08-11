---
"@nipakke/zero-vue": minor
---

**Breaking:** removed per-call `MutationCallOptions` from `mutate`. `timeout`, `throwOnTimeout`, and `throwOnError` are now composable-level only (`UseMutatorOptions`); `mutate(...args)` takes only the mutator's arguments. The trailing-options heuristic is gone, so a payload like `mutators.updateUser({ timeout: 60 })` is no longer mis-split.

```ts
// Before — `{timeout: 60}` could be misread as call options
mutate({ id: 1, timeout: 60 }, { throwOnError: false });

// After — options live on `useMutator`; `mutate` takes only the payload
const { mutate } = useMutator(zero, () => mutators.updateUser, { throwOnError: false });
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
