import { describe, expect, test } from "vite-plus/test";
import {
  useMutation,
  MutationTimeoutError,
  DEFAULT_MUTATION_TIMEOUT_MS,
} from "../src/mutation.ts";
import { createBindings } from "../src/create-bindings.ts";
import {
  Zero,
  createSchema,
  table,
  string,
  number,
  defineMutatorsWithType,
  defineMutator,
  createBuilder,
} from "@rocicorp/zero";

const schema = createSchema({
  tables: [table("item").columns({ id: number(), name: string() }).primaryKey("id")],
  enableLegacyMutators: true,
});

// Registry mutators are executed by the Zero they were passed to, so every
// zero in these tests is constructed with the same registry that the
// composables bind.
const defineMutatorsWithSchema = defineMutatorsWithType<typeof schema>();
const mutators = defineMutatorsWithSchema({
  addItem: defineMutator<{ id: number; name: string }, typeof schema>(
    async ({ tx, args }) => {
      await tx.mutate.item.insert(args);
    },
  ),
  fail: defineMutator<{ id: number; name: string }, typeof schema>(async () => {
    throw new Error("boom");
  }),
  // A mutator whose client promise never settles, so the timeout race (rather
  // than a real Zero promise) is what the tracking tests observe.
  hang: defineMutator<{ id: number; name: string }, typeof schema>(async () => {
    await new Promise(() => {});
  }),
});

// Strips the `Symbol(rc)` row-context symbols Zero attaches to rows.
const rows = (d: unknown) =>
  JSON.parse(JSON.stringify(d)) as { id: number; name: string }[];

// Flushes the microtask queue (the tracking chain runs after the awaited
// client promise's own handlers), so state assertions see the settled result.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Zero's logger writes the deliberate error-path failures (the `fail` mutator's
// "app error" logs) and startup notices to stderr; a no-op sink keeps the test
// output clean.
const silentLogSink = { log: () => {} };

describe("useMutation", () => {
  test("tracks isPending and delivers data via a registry mutator", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { mutate, isPending, error } = useMutation(
      z,
      (item: { id: number; name: string }) =>
        mutators.addItem(item),
    );

    const result = mutate({ id: 1, name: "alpha" });
    expect(isPending.value).toBe(true);

    await result.client;
    // The tracking chain is attached after the awaited promise's own handlers,
    // so flush the microtask queue before asserting.
    await flush();

    expect(isPending.value).toBe(false);
    expect(error.value).toBeNull();
    expect(rows(await z.run(createBuilder(schema).item))).toEqual([
      { id: 1, name: "alpha" },
    ]);
  });

  test("surfaces a timed-out tracked promise in error", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    // Zero normalizes mutation failures into resolved error-details (never
    // rejects), so the only genuine rejection the composable tracks is the
    // timeout race. A `hang` mutator leaves the client promise unsettled, so
    // the timeout fires and its rejection surfaces via the `error` ref.
    const { mutate, isPending, error } = useMutation(
      z,
      (item: { id: number; name: string }) => mutators.hang(item),
      { timeout: 50 },
    );

    mutate({ id: 1, name: "x" });
    expect(isPending.value).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    expect(isPending.value).toBe(false);
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
    expect(error.value?.message).toContain("50ms");
  });

  test("handles MutatorResultDetails error type (resolved but error)", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { mutate, isPending, error } = useMutation(
      z,
      (item: { id: number; name: string }) =>
        mutators.fail(item),
    );

    // The client promise resolves with `{type: 'error', error: {message}}`
    // rather than rejecting; the error still surfaces via `error`.
    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(error.value?.message).toBe("boom");
    expect(isPending.value).toBe(false);
  });

  test("times out when the tracked promise never settles", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { mutate, isPending, error } = useMutation(
      z,
      (item: { id: number; name: string }) => mutators.hang(item),
      { timeout: 50 },
    );

    mutate({ id: 1, name: "x" });
    expect(isPending.value).toBe(true);

    await new Promise((r) => setTimeout(r, 100)); // > 50ms timeout

    expect(isPending.value).toBe(false);
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
  });

  test("default timeout is 5 seconds", () => {
    expect(DEFAULT_MUTATION_TIMEOUT_MS).toBe(5_000);
  });

  test("per-call timeout overrides the composable timeout", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { mutate, isPending, error } = useMutation(
      z,
      (item: { id: number; name: string }) => mutators.hang(item),
      { timeout: 200 },
    );

    mutate({ id: 1, name: "x" }, { timeout: 20 });
    expect(isPending.value).toBe(true);

    await new Promise((r) => setTimeout(r, 60)); // > 20ms local timeout, < 200ms global

    expect(isPending.value).toBe(false);
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
    expect(error.value?.message).toContain("20ms");
  });

  test("throwOnTimeout rejects the call's tracked promise", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { mutate, error } = useMutation(
      z,
      (item: { id: number; name: string }) => mutators.hang(item),
      { timeout: 50, throwOnTimeout: true },
    );

    const result = mutate({ id: 1, name: "x" });

    await expect(result.client).rejects.toBeInstanceOf(MutationTimeoutError);
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
  });

  test("throwOnError rejects the call on error details", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { mutate, error } = useMutation(
      z,
      (item: { id: number; name: string }) =>
        mutators.fail(item),
      { throwOnError: true },
    );

    const result = mutate({ id: 1, name: "x" });

    await expect(result.client).rejects.toThrow("boom");
    expect(error.value?.message).toBe("boom");
  });

  test("per-call throwOnTimeout wins over the global default", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { mutate } = useMutation(
      z,
      (item: { id: number; name: string }) => mutators.hang(item),
      { timeout: 50 },
    );

    // Global throwOnTimeout defaults to false; the per-call flag opts in.
    const result = mutate({ id: 1, name: "x" }, { throwOnTimeout: true });
    await expect(result.client).rejects.toBeInstanceOf(MutationTimeoutError);
  });

  test("per-call throwOnTimeout: false suppresses the call rejection", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { mutate, error } = useMutation(
      z,
      (item: { id: number; name: string }) => mutators.hang(item),
      { timeout: 50, throwOnTimeout: true },
    );

    const result = mutate({ id: 1, name: "x" }, { throwOnTimeout: false });

    // The composable still tracks the timeout…
    await new Promise((r) => setTimeout(r, 100));
    expect(error.value).toBeInstanceOf(MutationTimeoutError);

    // …but the call's promise stays pending instead of rejecting.
    const outcome = await Promise.race([
      result.client.then(
        () => "settled",
        () => "rejected",
      ),
      new Promise((r) => setTimeout(() => r("pending"), 150)),
    ]);
    expect(outcome).toBe("pending");
  });

  test("works outside a component (no onUnmounted guard)", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    // getCurrentInstance() returns null outside setup(); useMutation must not
    // register onUnmounted and must still track mutations.
    const { mutate, isPending } = useMutation(
      z,
      (item: { id: number; name: string }) =>
        mutators.addItem(item),
    );

    const result = mutate({ id: 9, name: "outside" });
    await result.client;
    await flush();

    expect(isPending.value).toBe(false);
    expect(rows(await z.run(createBuilder(schema).item))).toEqual([
      { id: 9, name: "outside" },
    ]);
  });

  test("awaitMode: 'server' races the server promise", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    // With `server: null` the server promise never settles, so the timeout
    // race is the observable behavior: `awaitMode: 'server'` must not hang.
    const { mutate, isPending, error } = useMutation(
      z,
      (item: { id: number; name: string }) =>
        mutators.addItem(item),
      { awaitMode: "server", timeout: 50 },
    );

    mutate({ id: 3, name: "srv" });
    expect(isPending.value).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    expect(isPending.value).toBe(false);
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
  });
});

describe("createBindings", () => {
  test("bound useMutation uses the shared zero", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { useMutation } = createBindings(z);
    const { mutate, isPending } = useMutation(
      (_, item: { id: number; name: string }) =>
        mutators.addItem(item),
    );

    const result = mutate({ id: 6, name: "bound" });
    await result.client;
    await flush();

    expect(isPending.value).toBe(false);
    expect(rows(await z.run(createBuilder(schema).item))).toEqual([
      { id: 6, name: "bound" },
    ]);
  });

  test("bound useMutation with a mutator registry", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { useMutation } = createBindings(z, { mutators });
    const { mutate, isPending } = useMutation(
      ({ mutators }, item: { id: number; name: string }) =>
        mutators.addItem(item),
    );

    const result = mutate({ id: 1, name: "from-registry" });
    await result.client;
    await flush();

    expect(isPending.value).toBe(false);
    expect(rows(await z.run(createBuilder(schema).item))).toEqual([
      { id: 1, name: "from-registry" },
    ]);
  });

  test("bound useMutation accepts per-call options", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { useMutation } = createBindings(z, { mutators });
    const { mutate } = useMutation(
      ({ mutators }, item: { id: number; name: string }) =>
        mutators.fail(item),
    );

    const result = mutate({ id: 1, name: "x" }, { throwOnError: true });

    await expect(result.client).rejects.toThrow("boom");
  });

  test("mutators callback is rejected when no registry is bound", () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink });
    const { useMutation } = createBindings(z);

    // Without a registry the callback's context has `mutators: never`, so a
    // mutators-taking callback must not be assignable. Checked at the type
    // level via `@ts-expect-error` — the callback is never invoked.
    // @ts-expect-error - no mutator registry bound, so accessing ctx.mutators is rejected.
    const _rejected: Parameters<typeof useMutation>[0] = (ctx) => ctx.mutators.addItem({ id: 1, name: "x" });
    expect(_rejected).toBeTypeOf("function");

    // The mutate-only form still works.
    useMutation((_, item: { id: number; name: string }) =>
      mutators.addItem(item),
    );
  });
});

describe("useMutation — reset", () => {
  test("reset clears error and isPending", async () => {
    const z = new Zero({ server: null, userID: "test", schema, kvStore: "mem", logSink: silentLogSink, mutators });

    const { mutate, isPending, error, reset } = useMutation(
      z,
      (item: { id: number; name: string }) =>
        mutators.fail(item),
    );

    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(error.value).not.toBeNull();
    expect(isPending.value).toBe(false);

    reset();

    expect(error.value).toBeNull();
    expect(isPending.value).toBe(false);
  });
});
