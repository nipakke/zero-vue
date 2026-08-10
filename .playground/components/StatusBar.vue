<script setup lang="ts">
import { useConnectionState } from "@nipakke/zero-vue";
import { dropDatabase } from "@rocicorp/zero";
import { zero } from "../bindings.ts";

const state = useConnectionState(zero);

const reset = async () => {
  const dbName = zero.idbName;
  await zero.close();
  await dropDatabase(dbName, { kvStore: "idb" });
  location.reload();
};
</script>

<template>
  <div class="status">
    <div class="chip">
      <span class="conn-label">connection</span>
      <strong>{{ state.name }}</strong>
      <span v-if="'reason' in state && state.reason" class="conn-reason">{{ state.reason }}</span>
    </div>
    <button class="reset" title="Drop the IndexedDB database and reload" @click="reset">
      Reset data
    </button>
  </div>
</template>

<style scoped>
.status {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  box-shadow: var(--shadow);
}

.conn-label {
  color: var(--text-dim);
}

.conn-reason {
  color: var(--text-dim);
  font-size: 12px;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reset {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--danger);
}

.reset:hover {
  background: #fef2f2;
}
</style>
