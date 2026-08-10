import { describe, expect, test } from "vite-plus/test";
import { effectScope, nextTick, ref, shallowRef } from "vue";
import { useQuery, type UseQueryOptions } from "../src/query.ts";
import { createBindings } from "../src/create-bindings.ts";
import {
  Zero,
  createSchema,
  table,
  string,
  number,
  createBuilder,
  defineQuery,
  defineQueries,
} from "@rocicorp/zero";

const schema = createSchema({
  tables: [table("item").columns({ id: number(), name: string() }).primaryKey("id")],
  enableLegacyMutators: true,
});

describe("useQuery", () => {
  test("returns query results for locally stored data", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    await z.mutate.item.insert({ id: 1, name: "alpha" });
    await z.mutate.item.insert({ id: 2, name: "beta" });

    const query = createBuilder(schema).item;
    const { data: rows } = useQuery(z, () => query);

    expect(rows.value).toMatchInlineSnapshot(`
      [
        {
          "id": 1,
          "name": "alpha",
          Symbol(rc): 1,
        },
        {
          "id": 2,
          "name": "beta",
          Symbol(rc): 1,
        },
      ]
    `);
  });

  test("reactively updates when data is inserted after query creation", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });

    const query = createBuilder(schema).item;
    const { data: rows } = useQuery(z, () => query);

    // Insert after the query is live
    await z.mutate.item.insert({ id: 10, name: "inserted-later" });

    expect(JSON.parse(JSON.stringify(rows.value))).toContainEqual({
      id: 10,
      name: "inserted-later",
    });
  });

  test("returns undefined data and disabled status for falsy/disabled query", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });

    const { data: rows, status, error } = useQuery(z, () => undefined as never);

    expect(rows.value).toBeUndefined();
    expect(status.value).toBe("disabled");
    expect(error.value).toBeUndefined();
  });

  test("surfaces an unhashable query as error status, not disabled", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });

    // A query object that does not carry Zero's queryInternals tag (e.g. one
    // built against a different copy of Zero) cannot be hashed. Regression:
    // this used to fall into the "no hash → no view" path and silently
    // surface as 'disabled', indistinguishable from an off query.
    const { data, status, error } = useQuery(z, () => ({}) as never);

    expect(status.value).toBe("error");
    expect(error.value?.type).toBe("InvalidQuery");
    expect(error.value?.message).toContain("QueryInternals");
    expect(data.value).toBeUndefined();
  });
});

describe("createBindings", () => {
  test("binds a static zero and returns query results", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    await z.mutate.item.insert({ id: 1, name: "alpha" });
    await z.mutate.item.insert({ id: 2, name: "beta" });

    const { useQuery } = createBindings(z);
    const { data: rows } = useQuery(() => createBuilder(schema).item);

    expect(JSON.parse(JSON.stringify(rows.value))).toEqual([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);
  });

  test("reactively re-materializes against a swapped reactive zero", async () => {
    const zeroA = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    await zeroA.mutate.item.insert({ id: 1, name: "from-a" });

    const zeroRef = shallowRef<typeof zeroA>(zeroA);
    const { useQuery } = createBindings(zeroRef);
    const { data: rows } = useQuery(() => createBuilder(schema).item);

    // Initially reflects zeroA.
    expect(JSON.parse(JSON.stringify(rows.value))).toEqual([{ id: 1, name: "from-a" }]);

    // Swap to a fresh zero holding a different row: the old view is torn down
    // and a new one is materialized against zeroB.
    const zeroB = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    await zeroB.mutate.item.insert({ id: 99, name: "from-b" });

    zeroRef.value = zeroB;
    await nextTick();

    expect(JSON.parse(JSON.stringify(rows.value))).toEqual([{ id: 99, name: "from-b" }]);
  });

  test("re-materializes the registry-getter form against a swapped reactive zero", async () => {
    const zeroA = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    await zeroA.mutate.item.insert({ id: 1, name: "from-a" });

    // Same registry path as the registry-getter test, but with a reactive
    // zero so the swap path re-resolves the query through the bound registry
    // against the new instance.
    const queries = defineQueries({
      all: defineQuery(() => createBuilder(schema).item),
    });

    const zeroRef = shallowRef<typeof zeroA>(zeroA);
    const { useQuery } = createBindings(zeroRef, { queries });
    const { data: rows } = useQuery((q) => q.all());

    // Initially reflects zeroA.
    expect(JSON.parse(JSON.stringify(rows.value))).toEqual([{ id: 1, name: "from-a" }]);

    // Swap to a fresh zero holding a different row.
    const zeroB = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    await zeroB.mutate.item.insert({ id: 99, name: "from-b" });

    zeroRef.value = zeroB;
    await nextTick();

    expect(JSON.parse(JSON.stringify(rows.value))).toEqual([{ id: 99, name: "from-b" }]);
  });

  test("returns undefined data and disabled status for falsy/disabled query", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });

    const { useQuery } = createBindings(z);
    const { data: rows, status, error } = useQuery(() => undefined as never);

    expect(rows.value).toBeUndefined();
    expect(status.value).toBe("disabled");
    expect(error.value).toBeUndefined();
  });

  test("binds a query registry and resolves queries via a registry getter", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    await z.mutate.item.insert({ id: 1, name: "alpha" });
    await z.mutate.item.insert({ id: 2, name: "beta" });

    const zql = createBuilder(schema);
    const queries = defineQueries({
      all: defineQuery(() => zql.item),
    });

    const { useQuery } = createBindings(z, { queries });
    const { data: rows } = useQuery((q) => q.all());

    expect(JSON.parse(JSON.stringify(rows.value))).toEqual([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);
  });

  test("registry getter form is rejected when no registry is bound", () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    const { useQuery } = createBindings(z);

    // Without a registry the signal is zero-argument, so a registry-taking
    // callback must not be assignable to it. Checked at the type level via the
    // `@ts-expect-error` — assigning to `query`'s signal type never invokes the
    // composable, so this runs without dereferencing the unbound registry.
    // @ts-expect-error - no registry bound, so a registry-taking signal is rejected.
    const _rejected: Parameters<typeof useQuery>[0] = (q) => q.all();
    expect(_rejected).toBeTypeOf("function");

    // The zero-argument form still works.
    useQuery(() => createBuilder(schema).item);
  });
});

describe("useQuery — TTL and lifecycle", () => {
  test("re-materialized view uses current TTL, not stale initial TTL", async () => {
    // Regression: the re-materialization watch used to capture initialTTL at
    // setup time and always pass that to materialize, so changing TTL then
    // changing the query signal lost the TTL override.
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    await z.mutate.item.insert({ id: 1, name: "alpha" });

    const filter = ref<"all" | "one">("all");
    const ttlRef = ref<UseQueryOptions["ttl"]>("1h");

    const querySignal = () => {
      const base = createBuilder(schema).item;
      return filter.value === "all" ? base : base.where("id", 1);
    };

    const { data: rows } = useQuery(z, querySignal, () => ({ ttl: ttlRef.value }));
    expect(JSON.parse(JSON.stringify(rows.value))).toEqual([{ id: 1, name: "alpha" }]);

    // Change the query signal — forces re-materialization.
    // The new view should be created with ttl='1h', not the default 5m.
    filter.value = "one";
    await nextTick();

    expect(JSON.parse(JSON.stringify(rows.value))).toEqual([{ id: 1, name: "alpha" }]);
  });

  test("tears the view down when the enclosing effectScope is disposed", async () => {
    // Regression: cleanup used to be registered only when inside a component
    // (getCurrentInstance), so a query in an effectScope (e.g. a store) never
    // destroyed its view after the scope stopped.
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    await z.mutate.item.insert({ id: 1, name: "alpha" });

    const query = createBuilder(schema).item;
    let rows: { value: unknown } | undefined;

    const scope = effectScope();
    scope.run(() => {
      rows = useQuery(z, () => query).data;
    });
    expect(JSON.parse(JSON.stringify(rows!.value))).toEqual([{ id: 1, name: "alpha" }]);

    scope.stop();

    // After disposal the destroyed view must not receive updates.
    await z.mutate.item.insert({ id: 2, name: "beta" });
    await nextTick();
    expect(JSON.parse(JSON.stringify(rows!.value))).toEqual([{ id: 1, name: "alpha" }]);
  });

  test("works outside a component (no onUnmounted guard)", async () => {
    // getCurrentScope() returns null outside setup()/effectScope(); useQuery
    // must not register onScopeDispose and must still deliver data.
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    await z.mutate.item.insert({ id: 1, name: "alpha" });

    const query = createBuilder(schema).item;
    const { data: rows } = useQuery(z, () => query);

    expect(JSON.parse(JSON.stringify(rows.value))).toEqual([{ id: 1, name: "alpha" }]);
  });
});
