---
"@nipakke/zero-vue": patch
---

`useMutation`: the trailing `mutate` argument is now treated as call options only when it consists solely of the option keys (`timeout`, `throwOnTimeout`, `throwOnError`) with matching value types. Payloads that merely contain a `timeout`-named field, or carry option names with other value types, are passed through to the mutation untouched instead of being silently consumed.
