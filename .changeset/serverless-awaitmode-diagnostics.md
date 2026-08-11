---
"@nipakke/zero-vue": patch
---

Surface the `awaitMode: "server"` + no-server trap in `useMutator`. Issuing a `"server"` mutation against a zero with no server (`zero.server === null`) logs a one-time `console.warn` per composable at call time, and the resulting `MutationTimeoutError` now names the no-server case ("…zero.server is null, so the server promise can never settle") instead of a bare timeout — so the hang-by-design timeout is explainable rather than mysterious.
