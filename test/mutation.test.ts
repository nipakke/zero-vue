import { describe, expect, test, vi } from "vite-plus/test";
import {
  useMutator,
  MutationTimeoutError,
  MutationError,
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

const zql = createBuilder(schema);

// Registry mutators are executed by the Zero they were passed to, so every
// zero in these tests is constructed with the same registry that the
// composables bind.
const defineMutatorsWithSchema = defineMutatorsWithType<typeof schema>();
const mutators = defineMutatorsWithSchema({
  addItem: defineMutator<{ id: number; name: string }, typeof schema>(async ({ tx, args }) => {
    await tx.mutate.item.insert(args);
  }),
  fail: defineMutator<{ id: number; name: string }, typeof schema>(async () => {
    throw new Error("boom");
  }),
  // A mutator whose client promise never settles, so the timeout race (rather
  // than a real Zero promise) is what the tracking tests observe.
  hang: defineMutator<{ id: number; name: string }, typeof schema>(async () => {
    await new Promise(() => {});
  }),
  // Captures the raw args it receives (so tests can assert payload
  // pass-through), then inserts the row.
  record: defineMutator<
    {
      id: number;
      name: string;
      timeout?: number;
      throwOnTimeout?: string;
      throwOnError?: boolean;
    },
    typeof schema
  >(async ({ tx, args }) => {
    receivedArgs.push(args);
    await tx.mutate.item.insert({ id: args.id, name: args.name });
  }),
});

// Args captured by the `record` mutator, for payload pass-through assertions.
const receivedArgs: unknown[] = [];

// Flushes the microtask queue (the tracking chain runs after the awaited
// client promise's own handlers), so state assertions see the settled result.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Zero's logger writes the deliberate error-path failures (the `fail` mutator's
// "app error" logs) and startup notices to stderr; a no-op sink keeps the test
// output clean.
const silentLogSink = { log: () => {} };

describe("useMutator", () => {
  test("tracks isPending and delivers data via a registry mutator", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const { mutate, isPending, error } = useMutator(z, () => mutators.addItem);

    const result = mutate({ id: 1, name: "alpha" });
    expect(isPending.value).toBe(true);

    await result.client;
    // The tracking chain is attached after the awaited promise's own handlers,
    // so flush the microtask queue before asserting.
    await flush();

    expect(isPending.value).toBe(false);
    expect(error.value).toBeNull();
    expect(await z.run(zql.item)).toMatchInlineSnapshot(`
      [
        {
          "id": 1,
          "name": "alpha",
          Symbol(rc): 1,
        },
      ]
    `);
  });

  test("surfaces a timed-out tracked promise in error", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    // Zero normalizes mutation failures into resolved error-details (never
    // rejects), so the only genuine rejection the composable tracks is the
    // timeout race. A `hang` mutator leaves the client promise unsettled, so
    // the timeout fires and its rejection surfaces via the `error` ref.
    const { mutate, isPending, error } = useMutator(z, () => mutators.hang, { timeout: 50 });

    mutate({ id: 1, name: "x" });
    expect(isPending.value).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    expect(isPending.value).toBe(false);
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
    expect(error.value?.message).toContain("50ms");
  });

  test("rejects by default when the mutation resolves with error details", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const { mutate, isPending, error } = useMutator(z, () => mutators.fail);

    // Zero normalizes custom-mutator failures into *resolved* error details
    // (`{type: 'error', error: {message}}`), so without `throwOnError: false`
    // the call's promise rejects and the error also surfaces via `error`.
    await expect(mutate({ id: 1, name: "x" }).client).rejects.toThrow("boom");
    await flush();

    expect(error.value?.message).toBe("boom");
    expect(isPending.value).toBe(false);
  });

  test("throwOnError: false resolves with the error details instead of rejecting", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const { mutate, isPending, error } = useMutator(z, () => mutators.fail, {
      throwOnError: false,
    });

    const result = await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(result.type).toBe("error");
    expect(error.value?.message).toBe("boom");
    expect(isPending.value).toBe(false);
  });

  test("times out when the tracked promise never settles", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const { mutate, isPending, error } = useMutator(z, () => mutators.hang, { timeout: 50 });

    mutate({ id: 1, name: "x" });
    expect(isPending.value).toBe(true);

    await new Promise((r) => setTimeout(r, 100)); // > 50ms timeout

    expect(isPending.value).toBe(false);
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
  });

  test("onError fires with kind 'mutation' when the mutation fails", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const errors: Error[] = [];
    const { mutate, error } = useMutator(z, () => mutators.fail, {
      onError: ({ error }) => errors.push(error),
    });

    await expect(mutate({ id: 1, name: "x" }).client).rejects.toThrow("boom");
    await flush();

    // The observer receives the same branded error as the `error` ref, with
    // Zero's raw error details attached as `cause`.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MutationError);
    expect(errors[0]?.message).toBe("boom");
    expect((errors[0]?.cause as { message?: string } | undefined)?.message).toBe("boom");
    expect(error.value).toBe(errors[0]);
  });

  test("onError exposes the mutator's arguments object and name", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const seen: { id: number; name: string }[] = [];
    const seenNames: string[] = [];
    const { mutate } = useMutator(z, () => mutators.fail, {
      onError: ({ args, mutatorName }) => {
        seen.push(args);
        seenNames.push(mutatorName);
      },
    });

    await expect(mutate({ id: 7, name: "zeta" }).client).rejects.toThrow("boom");
    await flush();

    // `args` is the single object the mutator was called with (no tuple), and
    // `mutatorName` identifies which mutator settled.
    expect(seen).toEqual([{ id: 7, name: "zeta" }]);
    expect(seenNames).toEqual(["fail"]);
  });

  test("onError does not fire on success", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const errors: Error[] = [];
    const { mutate, error } = useMutator(z, () => mutators.addItem, {
      onError: ({ error }) => errors.push(error),
    });

    await mutate({ id: 1, name: "alpha" }).client;
    await flush();

    expect(errors).toHaveLength(0);
    expect(error.value).toBeNull();
  });

  test("onError receives a MutationTimeoutError when the tracked promise times out", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const errors: Error[] = [];
    const { mutate, error } = useMutator(z, () => mutators.hang, {
      timeout: 50,
      onError: ({ error }) => errors.push(error),
    });

    mutate({ id: 1, name: "x" });
    await new Promise((r) => setTimeout(r, 100)); // > 50ms timeout

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MutationTimeoutError);
    expect(error.value).toBe(errors[0]);
  });

  test("default timeout is 5 seconds", () => {
    expect(DEFAULT_MUTATION_TIMEOUT_MS).toBe(5_000);
  });

  test("onSettled fires on success with error undefined", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const settled: Array<{
      args: { id: number; name: string };
      error?: Error;
      mutatorName: string;
    }> = [];
    const { mutate } = useMutator(z, () => mutators.addItem, {
      onSettled: (info) => settled.push(info),
    });

    await mutate({ id: 1, name: "alpha" }).client;
    await flush();

    expect(settled).toHaveLength(1);
    expect(settled[0]?.args).toEqual({ id: 1, name: "alpha" });
    expect(settled[0]?.error).toBeUndefined();
    expect(settled[0]?.mutatorName).toBe("addItem");
  });

  test("onSettled fires on failure with the branded error", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const settled: Array<{
      args: { id: number; name: string };
      error?: Error;
      mutatorName: string;
    }> = [];
    const { mutate } = useMutator(z, () => mutators.fail, {
      onSettled: (info) => settled.push(info),
    });

    await expect(mutate({ id: 1, name: "x" }).client).rejects.toThrow("boom");
    await flush();

    expect(settled).toHaveLength(1);
    expect(settled[0]?.args).toEqual({ id: 1, name: "x" });
    expect(settled[0]?.error).toBeInstanceOf(MutationError);
  });

  test("onSettled fires on timeout and onError fires first", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const order: string[] = [];
    const { mutate } = useMutator(z, () => mutators.hang, {
      timeout: 50,
      onError: () => order.push("error"),
      onSettled: () => order.push("settled"),
    });

    mutate({ id: 1, name: "x" });
    await new Promise((r) => setTimeout(r, 100)); // > 50ms timeout

    expect(order).toEqual(["error", "settled"]);
  });

  test("onSuccess fires with args and mutatorName, before onSettled", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const successes: Array<{ args: { id: number; name: string }; mutatorName: string }> = [];
    const order: string[] = [];
    const { mutate } = useMutator(z, () => mutators.addItem, {
      onSuccess: (info) => {
        successes.push(info);
        order.push("success");
      },
      onSettled: () => order.push("settled"),
    });

    await mutate({ id: 1, name: "alpha" }).client;
    await flush();

    expect(successes).toEqual([{ args: { id: 1, name: "alpha" }, mutatorName: "addItem" }]);
    expect(order).toEqual(["success", "settled"]);
  });

  test("onSuccess does not fire on failure", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const successes: unknown[] = [];
    const { mutate } = useMutator(z, () => mutators.fail, {
      onSuccess: (info) => successes.push(info),
    });

    await expect(mutate({ id: 1, name: "x" }).client).rejects.toThrow("boom");
    await flush();

    expect(successes).toHaveLength(0);
  });

  test("throwOnTimeout rejects the call's tracked promise", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const { mutate, error } = useMutator(z, () => mutators.hang, {
      timeout: 50,
      throwOnTimeout: true,
    });

    const result = mutate({ id: 1, name: "x" });

    await expect(result.client).rejects.toBeInstanceOf(MutationTimeoutError);
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
  });

  test("throwOnError rejects the call on error details", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const { mutate, error } = useMutator(z, () => mutators.fail, { throwOnError: true });

    const result = mutate({ id: 1, name: "x" });

    await expect(result.client).rejects.toThrow("boom");
    expect(error.value?.message).toBe("boom");
  });

  test("by default a timeout does not reject the call's promise", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    // Real wall-clock waits are deliberate here: the timeout race is a real
    // `setTimeout` on the platform clock, and this file's convention is real
    // (not fake) timers, so deterministic time control cannot apply.
    const { mutate, error } = useMutator(z, () => mutators.hang, { timeout: 50 });

    const result = mutate({ id: 1, name: "x" });

    // The composable still tracks the timeout…
    await new Promise((r) => setTimeout(r, 100));
    expect(error.value).toBeInstanceOf(MutationTimeoutError);

    // …but with throwOnTimeout unset (default false), the call's promise
    // stays pending instead of rejecting.
    const outcome = await Promise.race([
      result.client.then(
        () => "settled",
        () => "rejected",
      ),
      new Promise((r) => setTimeout(() => r("pending"), 150)),
    ]);
    expect(outcome).toBe("pending");
  });

  test("passes a payload containing a timeout-like field through to the mutator", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    // A payload may legitimately carry a `timeout` field. Since per-call
    // options were removed, `mutate` never inspects its arguments — the whole
    // payload (including the `timeout` field) must arrive at the mutator
    // intact.
    receivedArgs.length = 0;
    const { mutate, error } = useMutator(z, () => mutators.record);

    const result = mutate({ id: 7, name: "timed", timeout: 123 });
    await result.client;
    await flush();

    expect(error.value).toBeNull();
    expect(receivedArgs).toEqual([{ id: 7, name: "timed", timeout: 123 }]);
    expect(await z.run(zql.item)).toMatchInlineSnapshot(`
      [
        {
          "id": 7,
          "name": "timed",
          Symbol(rc): 1,
        },
      ]
    `);
  });

  test("passes a payload whose option-named keys have the wrong value types", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    // `throwOnTimeout` is just a payload field here. Since per-call options
    // were removed, `mutate` never inspects its arguments — the whole object
    // reaches the mutator as a payload.
    receivedArgs.length = 0;
    const { mutate, error } = useMutator(z, () => mutators.record);

    const result = mutate({ id: 8, name: "flag", throwOnTimeout: "yes" });
    await result.client;
    await flush();

    expect(error.value).toBeNull();
    expect(receivedArgs).toEqual([{ id: 8, name: "flag", throwOnTimeout: "yes" }]);
  });

  test("works outside a component (no onUnmounted guard)", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    // getCurrentScope() returns null outside setup()/effectScope(); useMutator
    // must not register onScopeDispose and must still track mutations.
    const { mutate, isPending } = useMutator(z, () => mutators.addItem);

    const result = mutate({ id: 9, name: "outside" });
    await result.client;
    await flush();

    expect(isPending.value).toBe(false);
    expect(await z.run(zql.item)).toMatchInlineSnapshot(`
      [
        {
          "id": 9,
          "name": "outside",
          Symbol(rc): 1,
        },
      ]
    `);
  });

  test("awaitMode: 'server' races the server promise", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    // With `server: null` the server promise never settles, so the timeout
    // race is the observable behavior: `awaitMode: 'server'` must not hang.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mutate, isPending, error } = useMutator(z, () => mutators.addItem, {
      awaitMode: "server",
      timeout: 50,
    });

    mutate({ id: 3, name: "srv" });
    expect(isPending.value).toBe(true);

    // The no-server trap is surfaced up front, at call time, not only via the
    // later timeout.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("zero.server is null");

    await new Promise((r) => setTimeout(r, 100));

    expect(isPending.value).toBe(false);
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
    // The timeout error names the no-server case instead of a bare timeout.
    expect(error.value?.message).toContain("zero.server is null");
    warn.mockRestore();
  });

  test("awaitMode: 'server' on a serverless zero warns once across calls", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mutate } = useMutator(z, () => mutators.addItem, { awaitMode: "server", timeout: 50 });

    mutate({ id: 4, name: "a" });
    mutate({ id: 5, name: "b" });

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("createBindings", () => {
  test("bound useMutator uses the shared zero", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const { useMutator } = createBindings(z);
    const { mutate, isPending } = useMutator(() => mutators.addItem);

    const result = mutate({ id: 6, name: "bound" });
    await result.client;
    await flush();

    expect(isPending.value).toBe(false);
    expect(await z.run(zql.item)).toMatchInlineSnapshot(`
      [
        {
          "id": 6,
          "name": "bound",
          Symbol(rc): 1,
        },
      ]
    `);
  });

  test("bound useMutator with a mutator registry", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const { useMutator } = createBindings(z, { mutators });
    const { mutate, isPending } = useMutator((mutators) => mutators.addItem);

    const result = mutate({ id: 1, name: "from-registry" });
    await result.client;
    await flush();

    expect(isPending.value).toBe(false);
    expect(await z.run(zql.item)).toMatchInlineSnapshot(`
      [
        {
          "id": 1,
          "name": "from-registry",
          Symbol(rc): 1,
        },
      ]
    `);
  });

  test("bound useMutator applies composable options", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const { useMutator } = createBindings(z, { mutators });
    const { mutate } = useMutator((mutators) => mutators.fail, { throwOnError: true });

    const result = mutate({ id: 1, name: "x" });

    await expect(result.client).rejects.toThrow("boom");
  });

  test("mutators callback is rejected when no registry is bound", () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
    });
    const { useMutator } = createBindings(z);

    // Without a registry the getter's parameter is `never`, so a
    // mutators-taking getter must not be assignable. Checked at the type
    // level via `@ts-expect-error` — the getter is never invoked.
    const _rejected: Parameters<typeof useMutator>[0] = (mutators) =>
      // @ts-expect-error - no mutator registry bound, so accessing mutators.addItem is rejected.
      mutators.addItem;
    expect(_rejected).toBeTypeOf("function");

    // The registry-closing form still works.
    useMutator(() => mutators.addItem);
  });

  test("bindings-level onError fires on bound mutation failure", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const errors: Error[] = [];
    const { useMutator } = createBindings(z, {
      mutators,
      onMutationError: ({ error }) => errors.push(error),
    });
    const { mutate } = useMutator((mutators) => mutators.fail);

    await expect(mutate({ id: 1, name: "x" }).client).rejects.toThrow("boom");
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MutationError);
    expect(errors[0]?.message).toBe("boom");
  });

  test("local onError and bindings-level onError both fire, local first", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const order: string[] = [];
    const { useMutator } = createBindings(z, {
      mutators,
      onMutationError: () => order.push("global"),
    });
    const { mutate } = useMutator((mutators) => mutators.fail, {
      onError: () => order.push("local"),
    });

    await expect(mutate({ id: 1, name: "x" }).client).rejects.toThrow("boom");
    await flush();

    expect(order).toEqual(["local", "global"]);
  });

  test("bindings-level onMutationSuccess fires on bound mutation success", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const successes: Array<{ args: unknown; mutatorName: string }> = [];
    const { useMutator } = createBindings(z, {
      mutators,
      onMutationSuccess: (info) => successes.push(info),
    });
    const { mutate } = useMutator((mutators) => mutators.addItem);

    await mutate({ id: 3, name: "c" }).client;
    await flush();

    expect(successes).toHaveLength(1);
    expect(successes[0]?.args).toEqual({ id: 3, name: "c" });
    expect(successes[0]?.mutatorName).toBe("addItem");
  });

  test("local onSuccess and bindings-level onMutationSuccess both fire, local first", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const order: string[] = [];
    const { useMutator } = createBindings(z, {
      mutators,
      onMutationSuccess: () => order.push("global"),
    });
    const { mutate } = useMutator((mutators) => mutators.addItem, {
      onSuccess: () => order.push("local"),
    });

    await mutate({ id: 4, name: "d" }).client;
    await flush();

    expect(order).toEqual(["local", "global"]);
  });

  test("bound useMutator with only a local onError fires once", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    // No bindings-level observer: the composed callback must skip the global
    // call and fire exactly once.
    const errors: Error[] = [];
    const { useMutator } = createBindings(z, { mutators });
    const { mutate } = useMutator((mutators) => mutators.fail, {
      onError: ({ error }) => errors.push(error),
    });

    await expect(mutate({ id: 1, name: "x" }).client).rejects.toThrow("boom");
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MutationError);
  });

  test("bound useMutator honors getter options through the composition", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    // The composed options wrapper must resolve a getter-form options
    // argument just like the raw composable does.
    const errors: Error[] = [];
    const { useMutator } = createBindings(z, { mutators });
    const { mutate } = useMutator(
      (mutators) => mutators.fail,
      () => ({ onError: ({ error }) => errors.push(error) }),
    );

    await expect(mutate({ id: 1, name: "x" }).client).rejects.toThrow("boom");
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MutationError);
  });
});

describe("useMutator — reset", () => {
  test("reset clears error and isPending", async () => {
    const z = new Zero({
      server: null,
      userID: "test",
      schema,
      kvStore: "mem",
      logSink: silentLogSink,
      mutators,
    });

    const { mutate, isPending, error, reset } = useMutator(z, () => mutators.fail, {
      throwOnError: false,
    });

    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(error.value).not.toBeNull();
    expect(isPending.value).toBe(false);

    reset();

    expect(error.value).toBeNull();
    expect(isPending.value).toBe(false);
  });
});
