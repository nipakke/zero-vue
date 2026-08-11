import { describe, expect, test } from "vite-plus/test";
import {
  useMutator,
  MutationTimeoutError,
  MutationError,
  DEFAULT_MUTATION_TIMEOUT_MS,
  type MutationKind,
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
  type MutatorResultDetails,
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
    { id: number; name: string; timeout?: number; throwOnTimeout?: string },
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

// Every test gets its own isolated zero: the in-memory store is keyed by the
// replicache name (`zero-<userID>-<hash>`), so a unique `userID` per instance
// prevents rows leaking across tests (the previous shared-name setup made the
// suite order/GC-sensitive).
let zeroCounter = 0;
function makeZero() {
  return new Zero({
    server: null,
    userID: `test-${++zeroCounter}`,
    schema,
    kvStore: "mem",
    logSink: silentLogSink,
    mutators,
  });
}

// A never-settling promise, for controlled timeout tests.
const hangPromise = () => new Promise<MutatorResultDetails>(() => {});

// A promise whose settlement the test controls, for sequencing the client and
// server legs of a live-server mutation.
function deferred() {
  let resolve!: (value: MutatorResultDetails) => void;
  const promise = new Promise<MutatorResultDetails>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A minimal stand-in for the parts of Zero the composable reads when deciding
 * whether a live server exists and executing a mutation: `server`,
 * `connection.state.current.name`, and `mutate()`. Feeds controlled
 * client/server promises so the live-server branch can be exercised without a
 * real backend (which the offline test harness cannot provide). The mutator
 * getter still uses the real registry mutator (its invocation only builds a
 * `MutateRequest`), so only `mutate()` is substituted.
 */
function makeFakeZero(opts: {
  name?: "connected" | "disconnected";
  client?: Promise<MutatorResultDetails>;
  server?: Promise<MutatorResultDetails>;
}) {
  const { name = "connected", client = hangPromise(), server = hangPromise() } = opts;
  return {
    server: { kind: "fake" },
    connection: { state: { current: { name } } },
    mutate: () => ({ client, server }),
  };
}

describe("useMutator", () => {
  test("tracks the client leg and delivers data via a registry mutator", async () => {
    const z = makeZero();

    const { mutate, isPending, client, error } = useMutator(z, () => mutators.addItem);

    const result = mutate({ id: 1, name: "alpha" });
    expect(client.isPending.value).toBe(true);
    expect(isPending.value).toBe(true);

    // Without a live server, `mutate().server` is the client promise itself.
    expect(result.server).toBe(result.client);

    await result.client;
    await flush();

    expect(client.isPending.value).toBe(false);
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

  test("server surface mirrors client when there is no live server", async () => {
    const z = makeZero();

    const { mutate, client, server, isPending, error } = useMutator(z, () => mutators.fail);

    const result = mutate({ id: 1, name: "x" });
    expect(result.server).toBe(result.client);
    expect(server.isPending.value).toBe(client.isPending.value);

    await result.client;
    await flush();

    // With no live server the local write is authoritative: the server leg
    // reports the same outcome as the client leg, and the combined `error`
    // reflects it too.
    expect(server.isPending.value).toBe(false);
    expect(server.error.value).toBe(client.error.value);
    expect(server.error.value).toBeInstanceOf(MutationError);
    expect(error.value).toBeInstanceOf(MutationError);
    expect(isPending.value).toBe(false);
  });

  test("surfaces a timed-out client leg in error", async () => {
    const z = makeZero();

    // Zero normalizes mutation failures into resolved error-details (never
    // rejects), so the only genuine rejection a leg tracks is its timeout
    // race. A `hang` mutator leaves the client promise unsettled, so the
    // timeout fires and its rejection surfaces via the `client`/combined
    // `error` refs.
    const { mutate, client, isPending, error } = useMutator(z, () => mutators.hang, {
      timeout: 50,
    });

    mutate({ id: 1, name: "x" });
    expect(client.isPending.value).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    expect(client.isPending.value).toBe(false);
    expect(client.error.value).toBeInstanceOf(MutationTimeoutError);
    expect(isPending.value).toBe(false);
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
  });

  test("reports a mutation failure on the client leg with a branded error", async () => {
    const z = makeZero();

    // Zero normalizes custom-mutator failures into *resolved* error details
    // (`{type: 'error', error: {message}}`), so `mutate().client` resolves
    // with them and the composable surfaces the failure via the refs and
    // observers rather than by rejecting.
    const { mutate, client, error } = useMutator(z, () => mutators.fail);

    const result = await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(result.type).toBe("error");
    expect(client.error.value?.message).toBe("boom");
    expect(client.error.value).toBeInstanceOf(MutationError);
    expect(error.value).toBeInstanceOf(MutationError);
  });

  test("onError fires with kind 'client' and the branded error", async () => {
    const z = makeZero();

    const errors: Array<{ error: Error; kind: MutationKind }> = [];
    const { mutate, client } = useMutator(z, () => mutators.fail, {
      onError: (info) => errors.push({ error: info.error, kind: info.kind }),
    });

    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("client");
    expect(errors[0]?.error).toBeInstanceOf(MutationError);
    expect(errors[0]?.error.message).toBe("boom");
    expect((errors[0]?.error.cause as { message?: string } | undefined)?.message).toBe("boom");
    expect(client.error.value).toBe(errors[0]?.error);
  });

  test("onError exposes the mutator's arguments object, name, and kind", async () => {
    const z = makeZero();

    const seen: Array<{ args: { id: number; name: string }; mutatorName: string; kind: MutationKind }> =
      [];
    const { mutate } = useMutator(z, () => mutators.fail, {
      onError: ({ args, mutatorName, kind }) => {
        seen.push({ args, mutatorName, kind });
      },
    });

    await mutate({ id: 7, name: "zeta" }).client;
    await flush();

    expect(seen).toEqual([{ args: { id: 7, name: "zeta" }, mutatorName: "fail", kind: "client" }]);
  });

  test("onError does not fire on success", async () => {
    const z = makeZero();

    const errors: Error[] = [];
    const { mutate, client } = useMutator(z, () => mutators.addItem, {
      onError: ({ error }) => errors.push(error),
    });

    await mutate({ id: 1, name: "alpha" }).client;
    await flush();

    expect(errors).toHaveLength(0);
    expect(client.error.value).toBeNull();
  });

  test("onError receives a MutationTimeoutError when the client leg times out", async () => {
    const z = makeZero();

    const errors: Array<{ error: Error; kind: MutationKind }> = [];
    const { mutate, client } = useMutator(z, () => mutators.hang, {
      timeout: 50,
      onError: ({ error, kind }) => errors.push({ error, kind }),
    });

    mutate({ id: 1, name: "x" });
    await new Promise((r) => setTimeout(r, 100));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("client");
    expect(errors[0]?.error).toBeInstanceOf(MutationTimeoutError);
    expect(client.error.value).toBe(errors[0]?.error);
  });

  test("default timeout is 5 seconds", () => {
    expect(DEFAULT_MUTATION_TIMEOUT_MS).toBe(5_000);
  });

  test("onSettled fires on success with error undefined and kind client", async () => {
    const z = makeZero();

    const settled: Array<{
      args: { id: number; name: string };
      error?: Error;
      mutatorName: string;
      kind: MutationKind;
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
    expect(settled[0]?.kind).toBe("client");
  });

  test("onSettled fires on failure with the branded error and kind client", async () => {
    const z = makeZero();

    const settled: Array<{
      args: { id: number; name: string };
      error?: Error;
      mutatorName: string;
      kind: MutationKind;
    }> = [];
    const { mutate } = useMutator(z, () => mutators.fail, {
      onSettled: (info) => settled.push(info),
    });

    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(settled).toHaveLength(1);
    expect(settled[0]?.args).toEqual({ id: 1, name: "x" });
    expect(settled[0]?.error).toBeInstanceOf(MutationError);
    expect(settled[0]?.kind).toBe("client");
  });

  test("onSettled fires on timeout and onError fires first", async () => {
    const z = makeZero();

    const order: string[] = [];
    const { mutate } = useMutator(z, () => mutators.hang, {
      timeout: 50,
      onError: ({ kind }) => order.push(`error-${kind}`),
      onSettled: ({ kind }) => order.push(`settled-${kind}`),
    });

    mutate({ id: 1, name: "x" });
    await new Promise((r) => setTimeout(r, 100));

    expect(order).toEqual(["error-client", "settled-client"]);
  });

  test("onSuccess fires with args, mutatorName, kind client, before onSettled", async () => {
    const z = makeZero();

    const successes: Array<{ args: { id: number; name: string }; mutatorName: string; kind: MutationKind }> =
      [];
    const order: string[] = [];
    const { mutate } = useMutator(z, () => mutators.addItem, {
      onSuccess: (info) => {
        successes.push(info);
        order.push(`success-${info.kind}`);
      },
      onSettled: ({ kind }) => order.push(`settled-${kind}`),
    });

    await mutate({ id: 1, name: "alpha" }).client;
    await flush();

    expect(successes).toEqual([
      { args: { id: 1, name: "alpha" }, mutatorName: "addItem", kind: "client" },
    ]);
    expect(order).toEqual(["success-client", "settled-client"]);
  });

  test("onSuccess does not fire on failure", async () => {
    const z = makeZero();

    const successes: unknown[] = [];
    const { mutate } = useMutator(z, () => mutators.fail, {
      onSuccess: (info) => successes.push(info),
    });

    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(successes).toHaveLength(0);
  });

  test("passes a payload containing a timeout-like field through to the mutator", async () => {
    const z = makeZero();

    receivedArgs.length = 0;
    const { mutate, client } = useMutator(z, () => mutators.record);

    const result = mutate({ id: 7, name: "timed", timeout: 123 });
    await result.client;
    await flush();

    expect(client.error.value).toBeNull();
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

  test("passes a payload whose option-named keys are not special", async () => {
    const z = makeZero();

    receivedArgs.length = 0;
    const { mutate, client } = useMutator(z, () => mutators.record);

    const result = mutate({ id: 8, name: "flag", throwOnTimeout: "yes" });
    await result.client;
    await flush();

    expect(client.error.value).toBeNull();
    expect(receivedArgs).toEqual([{ id: 8, name: "flag", throwOnTimeout: "yes" }]);
  });

  test("works outside a component (no onUnmounted guard)", async () => {
    const z = makeZero();

    const { mutate, client } = useMutator(z, () => mutators.addItem);

    const result = mutate({ id: 9, name: "outside" });
    await result.client;
    await flush();

    expect(client.isPending.value).toBe(false);
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
});

describe("useMutator — live server", () => {
  test("tracks both legs and fires kind client then server on success", async () => {
    const clientP = Promise.resolve<MutatorResultDetails>({ type: "success" });
    const serverD = deferred();
    const fake = makeFakeZero({ client: clientP, server: serverD.promise });

    const kinds: MutationKind[] = [];
    const { mutate, client, server, isPending, error } = useMutator(
      fake as never,
      () => mutators.addItem,
      { onSettled: ({ kind }) => kinds.push(kind) },
    );

    const result = mutate({ id: 1, name: "x" });
    expect(result.server).not.toBe(result.client);

    await result.client;
    await flush();
    expect(kinds).toEqual(["client"]);
    expect(client.error.value).toBeNull();
    expect(server.isPending.value).toBe(true);
    expect(isPending.value).toBe(true);

    serverD.resolve({ type: "success" });
    await flush();
    expect(kinds).toEqual(["client", "server"]);
    expect(server.isPending.value).toBe(false);
    expect(server.error.value).toBeNull();
    expect(isPending.value).toBe(false);
    expect(error.value).toBeNull();
  });

  test("a slow server leg times out and reports on the server side", async () => {
    const clientP = Promise.resolve<MutatorResultDetails>({ type: "success" });
    const fake = makeFakeZero({ client: clientP, server: hangPromise() });

    const errors: Array<{ error: Error; kind: MutationKind }> = [];
    const { mutate, client, server, isPending, error } = useMutator(
      fake as never,
      () => mutators.addItem,
      { timeout: 50, onError: ({ error, kind }) => errors.push({ error, kind }) },
    );

    const result = mutate({ id: 1, name: "x" });
    await result.client;
    await flush();

    // The client leg succeeded; the server leg is still waiting on the backend.
    expect(client.error.value).toBeNull();
    expect(server.isPending.value).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    expect(server.isPending.value).toBe(false);
    expect(server.error.value).toBeInstanceOf(MutationTimeoutError);
    expect(errors).toEqual([{ error: expect.any(MutationTimeoutError), kind: "server" }]);
    // The combined error reflects the failed server leg even though the client
    // leg succeeded.
    expect(error.value).toBeInstanceOf(MutationTimeoutError);
    expect(isPending.value).toBe(false);
  });

  test("an offline-but-configured server mirrors the client (no server leg)", async () => {
    const clientP = Promise.resolve<MutatorResultDetails>({ type: "success" });
    const offlineFake = makeFakeZero({ name: "disconnected", client: clientP, server: hangPromise() });

    const kinds: MutationKind[] = [];
    const { mutate, client, server } = useMutator(offlineFake as never, () => mutators.addItem, {
      onSettled: ({ kind }) => kinds.push(kind),
    });

    const result = mutate({ id: 1, name: "x" });
    // Offline => the server promise can never settle, so it mirrors client.
    expect(result.server).toBe(result.client);
    expect(server.isPending.value).toBe(client.isPending.value);

    await result.client;
    await flush();

    expect(kinds).toEqual(["client"]);
    expect(server.isPending.value).toBe(false);
    expect(server.error.value).toBe(client.error.value);
  });
});

describe("createBindings", () => {
  test("bound useMutator uses the shared zero", async () => {
    const z = makeZero();

    const { useMutator } = createBindings(z);
    const { mutate, client } = useMutator(() => mutators.addItem);

    const result = mutate({ id: 6, name: "bound" });
    await result.client;
    await flush();

    expect(client.isPending.value).toBe(false);
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
    const z = makeZero();

    const { useMutator } = createBindings(z, { mutators });
    const { mutate, client } = useMutator((mutators) => mutators.addItem);

    const result = mutate({ id: 1, name: "from-registry" });
    await result.client;
    await flush();

    expect(client.isPending.value).toBe(false);
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

  test("bound useMutator reports failures via the shared zero", async () => {
    const z = makeZero();

    const { useMutator } = createBindings(z, { mutators });
    const { mutate, client } = useMutator((mutators) => mutators.fail);

    const result = await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(result.type).toBe("error");
    expect(client.error.value?.message).toBe("boom");
  });

  test("mutators callback is rejected when no registry is bound", () => {
    const z = makeZero();
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

  test("bindings-level onError fires on bound mutation failure with kind", async () => {
    const z = makeZero();

    const errors: Array<{ error: Error; kind: MutationKind }> = [];
    const { useMutator } = createBindings(z, {
      mutators,
      onMutationError: ({ error, kind }) => errors.push({ error, kind }),
    });
    const { mutate } = useMutator((mutators) => mutators.fail);

    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("client");
    expect(errors[0]?.error).toBeInstanceOf(MutationError);
    expect(errors[0]?.error.message).toBe("boom");
  });

  test("local onError and bindings-level onError both fire, local first", async () => {
    const z = makeZero();

    const order: string[] = [];
    const { useMutator } = createBindings(z, {
      mutators,
      onMutationError: ({ kind }) => order.push(`global-${kind}`),
    });
    const { mutate } = useMutator((mutators) => mutators.fail, {
      onError: ({ kind }) => order.push(`local-${kind}`),
    });

    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(order).toEqual(["local-client", "global-client"]);
  });

  test("bindings-level onMutationSuccess fires on bound mutation success with kind", async () => {
    const z = makeZero();

    const successes: Array<{ args: unknown; mutatorName: string; kind: MutationKind }> = [];
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
    expect(successes[0]?.kind).toBe("client");
  });

  test("local onSuccess and bindings-level onMutationSuccess both fire, local first", async () => {
    const z = makeZero();

    const order: string[] = [];
    const { useMutator } = createBindings(z, {
      mutators,
      onMutationSuccess: ({ kind }) => order.push(`global-${kind}`),
    });
    const { mutate } = useMutator((mutators) => mutators.addItem, {
      onSuccess: ({ kind }) => order.push(`local-${kind}`),
    });

    await mutate({ id: 4, name: "d" }).client;
    await flush();

    expect(order).toEqual(["local-client", "global-client"]);
  });

  test("bound useMutator with only a local onError fires once", async () => {
    const z = makeZero();

    const errors: Error[] = [];
    const { useMutator } = createBindings(z, { mutators });
    const { mutate } = useMutator((mutators) => mutators.fail, {
      onError: ({ error }) => errors.push(error),
    });

    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MutationError);
  });

  test("bound useMutator honors getter options through the composition", async () => {
    const z = makeZero();

    const errors: Error[] = [];
    const { useMutator } = createBindings(z, { mutators });
    const { mutate } = useMutator(
      (mutators) => mutators.fail,
      () => ({ onError: ({ error }) => errors.push(error) }),
    );

    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MutationError);
  });
});

describe("useMutator — reset", () => {
  test("reset clears error and isPending", async () => {
    const z = makeZero();

    const { mutate, client, error, reset } = useMutator(z, () => mutators.fail);

    await mutate({ id: 1, name: "x" }).client;
    await flush();

    expect(client.error.value).not.toBeNull();
    expect(error.value).not.toBeNull();

    reset();

    expect(client.error.value).toBeNull();
    expect(error.value).toBeNull();
    expect(client.isPending.value).toBe(false);
  });
});
