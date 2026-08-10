<script setup lang="ts">
import StatusBar from "./components/StatusBar.vue";
import ItemManager from "./components/ItemManager.vue";
</script>

<template>
  <header>
    <div>
      <h1>zero-vue playground</h1>
      <p class="tagline">
        <code>createBindings</code> · <code>useQuery</code> · <code>useConnectionState</code> —
        running against an in-memory, offline Zero instance (<code>server: null</code>).
      </p>
    </div>
    <StatusBar />
  </header>

  <main>
    <ItemManager />
  </main>

  <footer>
    Data persists in an IndexedDB-backed Zero instance (<code>kvStore: 'idb'</code>) — use
    <em>Reset data</em> to wipe the local database.
  </footer>
</template>

<style scoped>
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  flex-wrap: wrap;
  margin-bottom: 28px;
}

h1 {
  margin: 0 0 6px;
  font-size: 26px;
  letter-spacing: -0.02em;
}

.tagline {
  margin: 0;
  color: var(--text-dim);
  font-size: 14px;
  max-width: 560px;
}

.tagline code,
footer code {
  background: var(--accent-soft);
  color: var(--accent);
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 12.5px;
}

footer {
  margin-top: 32px;
  color: var(--text-dim);
  font-size: 13px;
}
</style>
