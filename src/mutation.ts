import {
  computed,
  getCurrentScope,
  onScopeDispose,
  ref,
  toValue,
  type ComputedRef,
  type MaybeRefOrGetter,
} from "vue";
import type {
  BaseDefaultContext,
  BaseDefaultSchema,
  CustomMutatorDefs,
  DefaultContext,
  DefaultSchema,
  MutateRequest,
  Mutator,
  MutatorResult,
  MutatorResultDetails,
  Zero,
} from "@rocicorp/zero";

/** Default `UseMutatorOptions.timeout` — 5 seconds. */
export const DEFAULT_MUTATION_TIMEOUT_MS = 5_000;

/**
 * Set as `error` when a tracked promise exceeds `timeout`. Checkable via
 * `instanceof`, alongside `MutationError` for app failures. `kind` (from the
 * callback info or which side's `error` ref it landed in) tells you whether it
 * was the client leg or the server leg that timed out.
 */
export class MutationTimeoutError extends Error {
  constructor(ms: number) {
    super(`Mutation timed out after ${ms}ms`);
  }
}

/**
 * Set as `error` when the mutation itself failed — a leg resolved with Zero
 * error details (`{type: 'error', ...}`) or its promise rejected. Checkable
 * via `instanceof`, alongside `MutationTimeoutError` for timeouts. When the
 * failure was normalized into resolved error details, `cause` carries Zero's
 * raw `{type: 'app' | 'zero', message, details?}` object.
 */
export class MutationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Which promise of the `MutatorResult` a callback/ref describes. */
export type MutationKind = "client" | "server";

/** Options for `useMutator`. `TArgs` is the mutator's single arguments object. */
export type UseMutatorOptions<TArgs = unknown> = {
  /**
   * Max ms to wait for either leg (client or server) before giving up. On
   * timeout that leg's `isPending` becomes `false`, its `error` is set to a
   * `MutationTimeoutError`, and `onError`/`onSettled` fire with the leg's
   * `kind`. The underlying `MutatorResult` promises are NOT cancelled (JS
   * promises can't be cancelled) — only the composable's tracking stops.
   * Default: `DEFAULT_MUTATION_TIMEOUT_MS` (5s). Pass `Infinity` to disable
   * the timeout entirely.
   */
  timeout?: number;
  /**
   * Observer called whenever a leg fails — a tracked promise timed out or the
   * mutation itself failed on that leg. Receives an info object: `error` is the
   * same branded `Error` set on that leg's `error` ref (`instanceof
   * MutationTimeoutError` for timeouts, `instanceof MutationError` for app
   * failures), `args` is the single arguments object the mutator was called
   * with, `mutatorName` identifies the mutator, and `kind` tells you whether
   * it was the client or server leg. Fires regardless of anything else — it is
   * a pure observer. When there is no live server, only the client leg is
   * tracked, so `kind` is always `"client"`. Typical uses: analytics, toasts,
   * logging. When the composable comes from `createBindings`, the
   * bindings-level `onError` fires too, after this one.
   */
  onError?: (info: { error: Error; args: TArgs; mutatorName: string; kind: MutationKind }) => void;
  /**
   * Observer called whenever a leg succeeds — a tracked promise resolved with
   * `{type: 'success'}`. Receives `args`, the mutator's arguments object,
   * `mutatorName`, and `kind` (`"client"` and, when there is a live server,
   * `"server"` once the server acks). Zero mutations return no value, so there
   * is no payload to carry — this fires purely as a success signal; re-read
   * with `useQuery` if you need the written record. Like `onError` it is a
   * pure observer. Fires before `onSettled`.
   */
  onSuccess?: (info: { args: TArgs; mutatorName: string; kind: MutationKind }) => void;
  /**
   * Observer called whenever a leg settles — whether it succeeded, timed out,
   * or the mutation itself failed on that leg. Fires after `onError` on
   * failure and after `onSuccess` on success, with `kind` identifying the leg.
   * Receives `args` (the mutator's arguments object), `mutatorName`, `error`
   * (set on failure/timeout, `undefined` on success), and `kind`. Like the
   * other observers it is a pure observer. Useful for teardown/logging that
   * runs on both success and failure paths.
   */
  onSettled?: (info: {
    args: TArgs;
    error?: Error;
    mutatorName: string;
    kind: MutationKind;
  }) => void;
};

/**
 * Type constraint for the mutator a `useMutator` getter must return. Derived
 * from Zero's own `Mutator` type (via `Pick`) so that a shape change on
 * Zero's side — e.g. a renamed field or a restructured phantom — surfaces as
 * a compile error here rather than a silent runtime break. We pick the
 * structural fields (`mutatorName`, `fn`, the `~` phantom) and add our own
 * bare callable rather than constraining to `Mutator<any, …>` outright:
 * widening `TInput` to `any` collapses Zero's conditional callable signature
 * to the zero-argument branch, which would reject concrete mutators (whose
 * required-arg signature isn't assignable to it). The `~.$input` phantom
 * carries the mutator's input type for typed reads.
 */
export type ZeroMutator = Pick<Mutator<any, any, any, any>, "mutatorName" | "fn" | "~"> &
  ((...args: any[]) => unknown);

/** Per-leg (client or server) status surface. */
export type MutatorSideResult = {
  isPending: ComputedRef<boolean>;
  error: ComputedRef<Error | null>;
};

/** Return shape of `useMutator`. */
export type MutationResult<TArgs extends unknown[]> = {
  /**
   * Execute the mutation against the current zero. Returns the raw
   * `MutatorResult` (`{ client, server }`); Zero normalizes both promises to
   * resolve with `MutatorResultDetails`, so neither rejects under normal
   * operation. When there is no live server, `server` is the *same* promise
   * as `client` — awaiting either yields the client outcome.
   */
  mutate: (...args: TArgs) => MutatorResult;
  /**
   * `true` while either leg is in flight: the client leg, and — when there is
   * a live server — the server leg. Read-only computed.
   */
  isPending: ComputedRef<boolean>;
  /** First failure across either leg, `null` otherwise. Read-only computed. */
  error: ComputedRef<Error | null>;
  /** The client leg's own `isPending` / `error`. */
  client: MutatorSideResult;
  /**
   * The server leg's own `isPending` / `error`. When there is no live server
   * this mirrors `client` (the local write is authoritative — there is no
   * separate server state to wait on).
   */
  server: MutatorSideResult;
  /**
   * Reset to idle state: clears `error` on both legs, sets `isPending` false,
   * invalidates in-flight callbacks.
   */
  reset: () => void;
};

/** Internal status of the latest tracked leg. */
type MutationStatus = "idle" | "pending" | "error";

/**
 * A light TanStack-Query-style mutation wrapper for Zero mutations.
 *
 * Tracks both the client and server legs of each mutation: `isPending` is
 * `true` while either is in flight, and `error` holds the first failure.
 * `client`/`server` give per-leg `isPending`/`error`, and the `onError` /
 * `onSuccess` / `onSettled` observers receive a `kind` telling them which leg
 * settled — so the composable reports exactly what is happening on each side
 * instead of hiding the server's outcome.
 *
 * `mutatorGetter` returns a `Mutator` from a mutator registry — a reference,
 * *not* a call — e.g. `() => mutators.addItem`. The composable invokes the
 * getter to obtain the mutator, executes it against the current zero via
 * `zero.mutate(mutator(...args))`, and tracks the result. Because the getter
 * returns the mutator itself, the selected mutator's argument type is
 * inferred onto `mutate`: `mutators.addItem` takes `{id, name}`, so
 * `mutate({id, name})`. The getter is evaluated per `mutate` call and never
 * captures a zero externally — the zero (which may be reactive) is read at
 * call time. `mutate` returns the raw `{ client, server }` `MutatorResult`;
 * the composable's reactive state and observers do the tracking:
 *
 * ```ts
 * const { mutate, isPending, error, client, server } = useMutator(zero, () => mutators.addItem);
 * mutate({ id: 1, name: "alpha" });
 * // client.isPending → true, then false when the local write commits
 * // server.isPending → true, then false when the server acks (if a server is live)
 * ```
 *
 * The bound `useMutator` from `createBindings` injects the shared reactive
 * zero and the mutator registry, so the getter receives the registry
 * directly: `useMutator((mutators) => mutators.addItem)`.
 *
 * A "live server" is a configured (`zero.server !== null`) *and* currently
 * connected (`zero.connection.state` is `connected`) backend. When there is
 * no live server — none configured, or the app is offline — the server leg is
 * never awaited: `mutate().server` is the client promise itself, `server`
 * mirrors `client`, and only `kind: "client"` observers fire. This avoids
 * hanging on a server promise that can never settle (offline or serverless).
 * When a server is live, the server leg is tracked against the real server
 * promise and reports its own outcome (and timeout).
 *
 * Each tracked leg races against `options.timeout`
 * (`DEFAULT_MUTATION_TIMEOUT_MS` by default); on timeout that leg's
 * `isPending` flips to `false` and its `error` becomes a `MutationTimeoutError`
 * (surfaced via `onError`/`onSettled` with the leg's `kind`), while the
 * underlying `MutatorResult` promises are left to settle on their own.
 *
 * `UseMutatorOptions.onError` observes every failure — timeouts and mutation
 * errors alike — receiving a `{ error, args, mutatorName, kind }` info object:
 * the same branded `Error` that is set on that leg's `error` ref
 * (`instanceof MutationTimeoutError` vs `instanceof MutationError` tells the
 * two apart), the mutator's arguments object, and which leg failed.
 * `UseMutatorOptions.onSuccess` fires when a leg succeeds (with `{ args,
 * kind }`), and `UseMutatorOptions.onSettled` fires on every settle (success
 * or failure) with `{ args, error?, kind }`.
 */
export function useMutator<
  S extends BaseDefaultSchema = DefaultSchema,
  MD extends CustomMutatorDefs | undefined = undefined,
  C extends BaseDefaultContext = DefaultContext,
  TMutator extends ZeroMutator = ZeroMutator,
>(
  zeroInput: MaybeRefOrGetter<Zero<S, MD, C>>,
  mutatorGetter: () => TMutator,
  options?:
    | UseMutatorOptions<TMutator["~"]["$input"]>
    | (() => UseMutatorOptions<TMutator["~"]["$input"]> | undefined),
): MutationResult<Parameters<TMutator>> {
  const zero = computed(() => toValue(zeroInput));
  const optionsRef = computed(() => toValue(options));
  const timeoutMs = computed(() => optionsRef.value?.timeout ?? DEFAULT_MUTATION_TIMEOUT_MS);

  // Per-leg status. The `server` surface mirrors the `client` surface while
  // `serverStatus` is `null` (no live server — nothing to wait on), and only
  // the client leg is tracked in that case.
  const clientStatus = ref<MutationStatus>("idle");
  const serverStatus = ref<MutationStatus | null>("idle");
  const clientError = ref<Error | null>(null);
  const serverError = ref<Error | null>(null);

  // Whether a live server exists right now: configured (`zero.server !==
  // null`) *and* connected. This is derived reactively — it is not stored
  // directly. Each mutation snapshots it into `serverStatus` (`null` when not
  // live), because the server surface must keep describing the in-flight
  // mutation's server leg even if the connection state changes before it
  // settles.
  const serverLive = computed(
    () => zero.value.server !== null && zero.value.connection.state.current.name === "connected",
  );

  // Monotonic counter for the latest mutation. In-flight callbacks for older
  // mutations are ignored, so an earlier leg's settlement can never clobber a
  // newer mutation's state (or `reset`'s idle state).
  let mutationId = 0;

  // Timers of in-flight timeout races, cleared when the scope is disposed so
  // they don't outlive the composable (a settled race's own finally removes
  // its timer from the set).
  const pendingTimers = new Set<number>();

  let disposed = false;
  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      for (const id of pendingTimers) {
        clearTimeout(id);
      }
      pendingTimers.clear();
    });
  }

  function mutate(...args: Parameters<TMutator>): MutatorResult {
    // Resolve the mutator from the getter, then invoke it with the caller's
    // args to build the `MutateRequest`, which is executed against the
    // current zero (read at call time so a reactive zero swap is honored).
    // A synchronous throw (e.g. a falsy zero) propagates to the caller before
    // any state is touched. The mutator is typed by the `ZeroMutator`
    // constraint (which widens its return to `unknown`), and TS cannot narrow
    // a variadic tuple to its prefix — hence the cast.
    const mutator = mutatorGetter();
    const request = mutator(...args) as MutateRequest<any, S, C, any>;
    const result = zero.value.mutate(request);

    // Snapshot the reactive "is there a live server" decision at call time:
    // when offline (or serverless) the server promise can never settle, so the
    // server leg is not tracked and the returned `server` promise is the
    // client promise itself — awaiting either yields the client outcome.
    const live = serverLive.value;

    const id = ++mutationId;
    // Zero mutators are arity-1 (the runtime callable is `(args) => …`), so
    // `args` is a single-element tuple and `args[0]` is the mutator's
    // arguments object — the `variables` surfaced to the callbacks. No tuple
    // is ever exposed.
    const variables = args[0] as TMutator["~"]["$input"];
    const timeout = timeoutMs.value;

    clientStatus.value = "pending";
    clientError.value = null;
    serverStatus.value = live ? "pending" : null;
    serverError.value = null;

    // Failure reporting for a leg: sets its state refs and notifies the
    // `UseMutatorOptions.onError` and `onSettled` observers (onError is
    // composed by `createBindings` to also fire the bindings-level callback,
    // local first). Observer throws are contained — they must not break the
    // tracking chain or double-fire via the catch handler.
    const report = (kind: MutationKind, error: Error) => {
      if (kind === "client") {
        clientError.value = error;
        clientStatus.value = "error";
      } else {
        serverError.value = error;
        serverStatus.value = "error";
      }
      const opts = optionsRef.value;
      const info = { args: variables, mutatorName: mutator.mutatorName, kind };
      if (opts?.onError) {
        try {
          opts.onError({ ...info, error });
        } catch (e) {
          console.error("onError callback threw", e);
        }
      }
      if (opts?.onSettled) {
        try {
          opts.onSettled({ ...info, error });
        } catch (e) {
          console.error("onSettled callback threw", e);
        }
      }
    };

    // Success reporting for a leg: `onSuccess` fires first, then `onSettled`
    // (with `error` undefined).
    const succeed = (kind: MutationKind) => {
      const opts = optionsRef.value;
      const info = { args: variables, mutatorName: mutator.mutatorName, kind };
      if (opts?.onSuccess) {
        try {
          opts.onSuccess(info);
        } catch (e) {
          console.error("onSuccess callback threw", e);
        }
      }
      if (opts?.onSettled) {
        try {
          opts.onSettled(info);
        } catch (e) {
          console.error("onSettled callback threw", e);
        }
      }
    };

    // Track a single leg (client always; server only when live). Races the
    // timeout so a never-settling promise (a hanging mutator, or a slow/offline
    // server) still flips that leg's `isPending` and reports a
    // `MutationTimeoutError` instead of hanging forever. Failures are branded
    // so consumers can tell them apart: `MutationTimeoutError` for timeouts
    // (only the race produces it), `MutationError` for resolved error details,
    // as-is for genuine rejections.
    const trackLeg = (kind: MutationKind, promise: Promise<MutatorResultDetails>) => {
      let timerId: number | undefined;
      let tracked: Promise<MutatorResultDetails>;
      if (timeout === Infinity) {
        tracked = promise;
      } else {
        const timer = new Promise<never>((_, reject) => {
          const tid = setTimeout(() => reject(new MutationTimeoutError(timeout)), timeout);
          timerId = tid;
          pendingTimers.add(tid);
        });
        tracked = Promise.race([promise, timer]);
      }
      tracked
        .then((details) => {
          if (disposed || id !== mutationId) return;
          if (details.type === "error") {
            report(kind, new MutationError(details.error.message, { cause: details.error }));
          } else {
            succeed(kind);
          }
        })
        .catch((e: unknown) => {
          if (disposed || id !== mutationId) return;
          report(kind, e instanceof Error ? e : new Error(String(e)));
        })
        .finally(() => {
          clearTimeout(timerId);
          if (timerId !== undefined) {
            pendingTimers.delete(timerId);
          }
          if (disposed || id !== mutationId) return;
          const status = kind === "client" ? clientStatus : serverStatus;
          if (status.value === "pending") status.value = "idle";
        });
    };

    trackLeg("client", result.client);
    if (live) trackLeg("server", result.server);

    // Without a live server the server promise can never settle, so
    // `mutate().server` is the client promise itself.
    return live
      ? { client: result.client, server: result.server }
      : { client: result.client, server: result.client };
  }

  function reset() {
    mutationId++;
    clientStatus.value = "idle";
    clientError.value = null;
    serverStatus.value = null;
    serverError.value = null;
  }

  const client: MutatorSideResult = {
    isPending: computed(() => clientStatus.value === "pending"),
    error: computed(() => clientError.value),
  };
  const server: MutatorSideResult = {
    isPending: computed(() =>
      serverStatus.value === null
        ? clientStatus.value === "pending"
        : serverStatus.value === "pending",
    ),
    error: computed(() => (serverStatus.value === null ? clientError.value : serverError.value)),
  };

  return {
    mutate,
    isPending: computed(
      () =>
        clientStatus.value === "pending" ||
        (serverStatus.value !== null && serverStatus.value === "pending"),
    ),
    error: computed(() => clientError.value ?? serverError.value),
    client,
    server,
    reset,
  };
}
