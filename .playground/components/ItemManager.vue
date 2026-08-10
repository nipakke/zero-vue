<script setup lang="ts">
import { computed, ref } from "vue";
import { type UseQueryOptions } from "@nipakke/zero-vue";
import { createBuilder } from "@rocicorp/zero";
import { schema, type ItemRow } from "../schema.ts";
import { useQuery, useMutation } from "../bindings.ts";
import QueryInspector from "./QueryInspector.vue";

// --- Interactive inputs that drive the query signal ------------------------
const newTitle = ref("");
const search = ref("");
const statusFilter = ref<"all" | "active" | "done">("all");
const sortDesc = ref(true);
const limit = ref<number>(10);
const ttl = ref<UseQueryOptions["ttl"]>(undefined);
const disabled = ref(false);

// --- Reactive query ----------------------------------------------------------
// Every ref read here re-evaluates the query and re-materializes the view.
const querySignal = () => {
  if (disabled.value) return undefined; // MaybeQueryResult path
  let q = createBuilder(schema).item;
  if (statusFilter.value !== "all") {
    q = q.where("done", statusFilter.value === "done");
  }
  const term = search.value.trim();
  if (term) {
    const escaped = term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    q = q.where(({ cmp }) => cmp("title", "LIKE", `%${escaped}%`));
  }
  q = q.orderBy("createdAt", sortDesc.value ? "desc" : "asc");
  if (limit.value > 0) {
    q = q.limit(limit.value);
  }
  return q;
};

const { data: rows, status } = useQuery(querySignal, () => ({ ttl: ttl.value }));

// --- Stats via three independent query calls ----------------------------------
const { data: allRows } = useQuery(() => createBuilder(schema).item);
const { data: activeRows } = useQuery(() => createBuilder(schema).item.where("done", false));
const { data: doneRows } = useQuery(() => createBuilder(schema).item.where("done", true));

const total = computed(() => allRows.value?.length ?? 0);
const active = computed(() => activeRows.value?.length ?? 0);
const done = computed(() => doneRows.value?.length ?? 0);

// --- Mutations via useMutation -------------------------------------------------
const { mutate: insertItem, isPending: isAdding } = useMutation(
  ({ mutators }, title: string) => {
    const id = Date.now();
    return mutators.addItem({ id, title, done: false, createdAt: id });
  },
);

const { mutate: toggleMutate } = useMutation(
  ({ mutators }, args: { id: number; done: boolean }) =>
    mutators.toggleItem(args),
);

const { mutate: deleteMutate } = useMutation(
  ({ mutators }, id: number) => mutators.deleteItem({ id }),
);

const addItem = () => {
  const title = newTitle.value.trim();
  if (!title) return;
  insertItem(title);
  newTitle.value = "";
};

const toggleItem = (row: ItemRow) => {
  void toggleMutate({ id: row.id, done: !row.done });
};

const removeItem = (row: ItemRow) => {
  void deleteMutate(row.id);
};

const clearDone = () => {
  for (const row of doneRows.value ?? []) {
    void deleteMutate(row.id);
  }
};

const markAllDone = () => {
  for (const row of activeRows.value ?? []) {
    void toggleMutate({ id: row.id, done: true });
  }
};
</script>

<template>
  <section class="card">
    <h2>Tasks</h2>

    <div class="add-row">
      <input
        v-model="newTitle"
        class="add-input"
        type="text"
        placeholder="What needs doing?"
        @keyup.enter="addItem"
      />
      <button
        class="btn btn-primary"
        :disabled="!newTitle.trim() || isAdding"
        @click="addItem"
      >
        {{ isAdding ? "Adding…" : "Add" }}
      </button>
    </div>

    <div class="stats">
      <div class="stat">
        <span class="stat-num">{{ total }}</span
        ><span class="stat-label">total</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ active }}</span
        ><span class="stat-label">active</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ done }}</span
        ><span class="stat-label">done</span>
      </div>
    </div>

    <div class="controls">
      <input v-model="search" class="search" type="search" placeholder="Search titles…" />
      <div class="segmented" role="group" aria-label="Status filter">
        <button :class="{ active: statusFilter === 'all' }" @click="statusFilter = 'all'">
          All
        </button>
        <button :class="{ active: statusFilter === 'active' }" @click="statusFilter = 'active'">
          Active
        </button>
        <button :class="{ active: statusFilter === 'done' }" @click="statusFilter = 'done'">
          Done
        </button>
      </div>
      <label class="field">
        Sort
        <select v-model="sortDesc">
          <option :value="true">newest</option>
          <option :value="false">oldest</option>
        </select>
      </label>
      <label class="field">
        Limit
        <select v-model.number="limit">
          <option :value="5">5</option>
          <option :value="10">10</option>
          <option :value="25">25</option>
          <option :value="0">none</option>
        </select>
      </label>
      <label class="field">
        TTL
        <select v-model="ttl">
          <option :value="undefined">default (5m)</option>
          <option value="10s">10s</option>
          <option value="1m">1m</option>
          <option value="1h">1h</option>
          <option value="forever">forever</option>
        </select>
      </label>
      <label class="check">
        <input v-model="disabled" type="checkbox" />
        disable query (falsy → <code>MaybeQueryResult</code>)
      </label>
    </div>

    <div v-if="disabled" class="empty">
      Query is disabled — <code>rows.value</code> is <code>undefined</code> (MaybeQueryResult).
    </div>
    <div v-else-if="!rows?.length" class="empty">
      No tasks match. Try clearing the search or filters.
    </div>
    <ul v-else class="list">
      <li v-for="row in rows" :key="row.id" class="item" :class="{ done: row.done }">
        <label class="toggle">
          <input type="checkbox" :checked="row.done" @change="toggleItem(row)" />
          <span class="title">{{ row.title }}</span>
        </label>
        <span class="meta">{{ new Date(row.createdAt).toLocaleDateString() }}</span>
        <button class="btn btn-ghost" title="Delete" @click="removeItem(row)">✕</button>
      </li>
    </ul>

    <div class="list-actions">
      <button class="btn btn-ghost" :disabled="active === 0" @click="markAllDone">
        Mark all done
      </button>
      <button class="btn btn-ghost" :disabled="done === 0" @click="clearDone">
        Clear completed
      </button>
    </div>

    <QueryInspector :rows="rows" :status="status" />
  </section>
</template>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 20px 22px;
}

h2 {
  margin: 0 0 14px;
  font-size: 18px;
}

.add-row {
  display: flex;
  gap: 10px;
}

.add-input {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: none;
}

.add-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.btn {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13.5px;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn-ghost {
  color: var(--text-dim);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--bg);
  color: var(--text);
}

.stats {
  display: flex;
  gap: 10px;
  margin: 14px 0;
}

.stat {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 8px;
  background: var(--bg);
  border-radius: 8px;
  padding: 10px 14px;
}

.stat-num {
  font-size: 20px;
  font-weight: 700;
}

.stat-label {
  color: var(--text-dim);
  font-size: 13px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  font-size: 13px;
}

.search {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  min-width: 170px;
}

.segmented {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.segmented button {
  border: none;
  background: var(--surface);
  padding: 8px 12px;
  font-size: 13px;
}

.segmented button + button {
  border-left: 1px solid var(--border);
}

.segmented button.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
}

.field select {
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 6px 8px;
  background: var(--surface);
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
}

.check code {
  font-size: 12px;
  background: var(--bg);
  padding: 1px 4px;
  border-radius: 4px;
}

.empty {
  padding: 28px 12px;
  text-align: center;
  color: var(--text-dim);
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-size: 14px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}

.item + .item {
  border-top: 1px solid var(--border);
}

.toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  cursor: pointer;
}

.item.done .title {
  text-decoration: line-through;
  color: var(--text-dim);
}

.meta {
  color: var(--text-dim);
  font-size: 12px;
}

.list-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
</style>
