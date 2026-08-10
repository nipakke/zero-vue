---
"@nipakke/zero-vue": patch
---

`useQuery`: a query that cannot be hashed (for example a query object built against a different copy of Zero) now reports `status: 'error'` with the underlying message in `error`, instead of silently surfacing as `'disabled'`.
