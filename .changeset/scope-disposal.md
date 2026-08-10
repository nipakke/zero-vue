---
"@nipakke/zero-vue": patch
---

`useQuery`, `useMutation`, and `useConnectionState` now register their cleanup on the active effect scope (`onScopeDispose`) instead of only inside components: used within an `effectScope` (e.g. a Pinia store), they now destroy views and unsubscribe when the scope stops. `useMutation` also clears in-flight timeout timers when the scope is disposed.
