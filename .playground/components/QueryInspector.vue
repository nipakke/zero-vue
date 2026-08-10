<script setup lang="ts">
import { computed } from "vue";
import type { QueryStatus } from "@nipakke/zero-vue";

const props = defineProps<{
  rows: unknown;
  status: QueryStatus;
}>();

const json = computed(() => JSON.stringify(props.rows ?? null, null, 2));
const statusLabel = computed(() => props.status);
</script>

<template>
  <details class="inspector">
    <summary>
      Query inspector — <code>status = {{ statusLabel }}</code>
    </summary>
    <pre>{{ json }}</pre>
  </details>
</template>

<style scoped>
.inspector {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  font-size: 13px;
}

.inspector summary {
  cursor: pointer;
  padding: 10px 14px;
  user-select: none;
}

.inspector code {
  color: var(--accent);
}

.inspector pre {
  margin: 0;
  padding: 12px 14px;
  border-top: 1px solid var(--border);
  overflow: auto;
  max-height: 260px;
  font-size: 12px;
  line-height: 1.45;
}
</style>
