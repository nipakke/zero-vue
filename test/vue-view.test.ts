import { describe, expect, test } from "vite-plus/test";
import { VueView, vueViewFactory } from "../src/vue-view.ts";
import { Zero, createSchema, table, string, number, createBuilder } from "@rocicorp/zero";

const schema = createSchema({
  tables: [table("item").columns({ id: number(), name: string() }).primaryKey("id")],
  enableLegacyMutators: true,
});

const rows = (data: unknown) => JSON.parse(JSON.stringify(data));

describe("VueView", () => {
  test("exposes reactive data, status, and error from a materialized view", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    const query = createBuilder(schema).item;

    const view = z.materialize(query, vueViewFactory) as VueView<unknown>;

    expect(view.data.value).toBeDefined();
    expect(view.status.value).toBe("unknown");
    expect(view.error.value).toBeUndefined();

    await z.mutate.item.insert({ id: 1, name: "foo" });

    expect(rows(view.data.value)).toEqual([{ id: 1, name: "foo" }]);
    // Local-only zero never completes a sync (server: null), so status stays 'unknown'.
    expect(view.status.value).toBe("unknown");
    view.destroy();
  });

  test("stops updating after destroy", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    const query = createBuilder(schema).item;

    const view = z.materialize(query, vueViewFactory) as VueView<unknown>;
    view.destroy();

    await z.mutate.item.insert({ id: 1, name: "foo" });

    expect(rows(view.data.value)).toEqual([]);
  });

  test("supports TTL updates", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    const query = createBuilder(schema).item;

    const view = z.materialize(query, vueViewFactory) as VueView<unknown>;
    view.updateTTL("10m");

    await z.mutate.item.insert({ id: 1, name: "foo" });

    expect(rows(view.data.value)).toEqual([{ id: 1, name: "foo" }]);
    view.destroy();
  });

  test("handles singular queries as a single row", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    const query = createBuilder(schema).item.one();

    const view = z.materialize(query, vueViewFactory) as VueView<unknown>;

    await z.mutate.item.insert({ id: 1, name: "foo" });

    expect(rows(view.data.value)).toEqual({ id: 1, name: "foo" });
    view.destroy();
  });

  test("handles empty singular queries as undefined", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    const query = createBuilder(schema).item.one();

    const view = z.materialize(query, vueViewFactory) as VueView<unknown>;

    expect(view.data.value).toBeUndefined();
    view.destroy();
  });

  test("surfaces error status and payload when queryComplete is an ErroredQuery", () => {
    // Construct a VueView directly with an ErroredQuery (not a Promise) to
    // exercise the synchronous error branch of #handleQueryComplete — the
    // path that server: null can never reach. The minimal Input fixture
    // returns no rows from fetch(), so the error path is the only thing
    // being tested, not Zero's query pipeline.
    const erroredQuery = {
      error: "app" as const,
      id: "test-id",
      name: "test-query",
      message: "Something went wrong",
      details: { code: 42 },
    };
    const view = new VueView(
      {
        getSchema: () => ({}) as never,
        fetch: () => [] as never,
        setOutput: () => {},
        destroy: () => {},
      } as never,
      { singular: false, relationships: {} },
      () => {},
      () => {},
      erroredQuery,
      () => {},
    );

    expect(view.status.value).toBe("error");
    expect(view.error.value).toMatchObject({
      type: "app",
      message: "Something went wrong",
      details: { code: 42 },
    });
    view.destroy();
  });

  test("changeToViewChange exhaustiveness guard throws on unknown type", () => {
    // The switch in changeToViewChange covers ChangeType 0-3 (ADD, REMOVE,
    // EDIT, CHILD). The default branch throws so a future Zero ChangeType
    // addition is a loud failure, not silent view corruption.
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem" });
    const query = createBuilder(schema).item;
    const view = z.materialize(query, vueViewFactory) as VueView<unknown>;

    // Construct a change tuple with an invalid type code and push it.
    const badChange = [99, { id: 1, name: "x" }, null] as unknown as never;

    expect(() => view.push(badChange)).toThrow(/Unknown change type/);
    view.destroy();
  });
});
