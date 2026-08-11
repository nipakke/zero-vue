---
"@nipakke/zero-vue": minor
---

**Breaking:** renamed `useMutation` to `useMutator` and changed the composable from a `mutationFn` that returns a `MutateRequest` to a getter that returns a `Mutator` reference (without calling it).

`useMutation` is now `useMutator`, and `UseMutationOptions` is `UseMutatorOptions`. The second argument is a getter returning the selected mutator — the mutator's argument type is inferred onto the returned `mutate`, so the args are no longer declared by the caller:

```ts
// Before
const { mutate } = useMutation(zero, (item) => mutators.addItem(item));
const { mutate } = useMutation(({ mutators }, item) => mutators.addItem(item));

// After
const { mutate } = useMutator(zero, () => mutators.addItem);
const { mutate } = useMutator((mutators) => mutators.addItem);
```

`mutate(...args)` behaves the same (`isPending`, `error`, `reset`, and `onError` are unchanged). The mutator getter is evaluated per `mutate` call and the zero is read at call time, so reactive zero/registry swaps are honored.
