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

/** Set as `error` when the tracked promise exceeds `timeout`. Checkable via `instanceof`. */
export class MutationTimeoutError extends Error {
  constructor(ms: number) {
    super(`Mutation timed out after ${ms}ms`);
  }
}

/**
 * Set as `error` when the mutation itself failed — it resolved with Zero
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

/** Options for `useMutator`. `TArgs` is the mutator's single arguments object. */
export type UseMutatorOptions<TArgs = unknown> = {
  /**
   * Which promise of the `MutatorResult` to track: `'client'` (default) or
   * `'server'`. `'server'` only settles once the server acknowledges the
   * mutation, so with no server the timeout race is what keeps the composable
   * from hanging.
   */
  awaitMode?: "client" | "server";
  /**
   * Default max ms to wait for the tracked promise (per `awaitMode`) before
   * giving up. On timeout, `isPending` becomes `false`, `error` is set to a
   * `MutationTimeoutError`, and that mutation's in-flight callbacks are
   * invalidated. The underlying `MutatorResult.client`/`.server` promises are
   * NOT cancelled (JS promises can't be cancelled) — only the composable's
   * tracking stops. Default: `DEFAULT_MUTATION_TIMEOUT_MS` (5s). Pass
   * `Infinity` to disable the timeout entirely.
   */
  timeout?: number;
  /**
   * Whether the promise returned by `mutate` should reject with a
   * `MutationTimeoutError` when the tracked promise exceeds `timeout`.
   * Default: `false` (the composable's `error` ref still reports it, but the
   * call itself resolves/waits for the real promise).
   */
  throwOnTimeout?: boolean;
  /**
   * Whether the promise returned by `mutate` should reject when the mutation
   * resolves with an error details object (`{type: 'error', ...}`) — i.e. the
   * mutation itself failed (custom mutator threw, zero error, …). Default:
   * `true` — `await mutate(...)` throws on mutation errors, and the error is
   * also reported via the `error` ref. Pass `false` to have the call resolve
   * with the error details instead (the `error` ref still reports it).
   * Genuine promise rejections always reject regardless of this flag.
   */
  throwOnError?: boolean;
  /**
   * Observer called whenever a mutation fails — either the tracked promise
   * timed out or the mutation itself failed. Receives a single info object:
   * `error` is the same branded `Error` set on the composable's `error` ref
   * (`instanceof MutationTimeoutError` when the tracked promise exceeded
   * `timeout`, `instanceof MutationError` when the mutation itself failed —
   * genuine rejections pass through as-is), and `args` is the single
   * arguments object the mutator was called with (identifies which concurrent
   * mutation failed). Fires regardless of `throwOnTimeout`/`throwOnError` —
   * it is a pure observer and does not change what `mutate` returns or what
   * `error` holds. Typical uses: analytics, toasts, logging. When the
   * composable comes from `createBindings`, the bindings-level
   * `onError` fires too, after this one.
   */
  onError?: (info: { error: Error; args: TArgs; mutatorName: string }) => void;
  /**
   * Observer called whenever a mutation succeeds — the tracked promise
   * resolved with `{type: 'success'}` (per `awaitMode`). Receives `args`, the
   * mutator's arguments object, and `mutatorName`. Zero mutations return no
   * value, so there is no payload to carry — this fires purely as a success
   * signal; re-read with `useQuery` if you need the written record. Like
   * `onError` it is a pure observer: it does not change what `mutate` returns
   * or what `error` holds. Fires before `onSettled`.
   */
  onSuccess?: (info: { args: TArgs; mutatorName: string }) => void;
  /**
   * Observer called whenever a mutation settles — whether it succeeded, timed
   * out, or the mutation itself failed. Fires after `onError` on failure and
   * after `onSuccess` on success. Receives `args` (the mutator's arguments
   * object), `mutatorName`, and `error`, which is set on failure/timeout and
   * `undefined` on success. Like the other observers it is a pure observer:
   * it does not change what `mutate` returns or what `error` holds. Useful
   * for teardown/logging that runs on both success and failure paths.
   */
  onSettled?: (info: { args: TArgs; error?: Error; mutatorName: string }) => void;
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

/** Return shape of `useMutator`. */
export type MutationResult<TArgs extends unknown[]> = {
  /** Execute the mutation against the current zero. All options are set on `useMutator`, not per call. */
  mutate: (...args: TArgs) => MutatorResult;
  /** `true` while the tracked promise (client or server per `awaitMode`) is in flight. */
  isPending: ComputedRef<boolean>;
  /** `Error` if the mutation failed, `null` otherwise. Read-only computed. */
  error: ComputedRef<Error | null>;
  /** Reset to idle state: clears `error`, sets `isPending` false, invalidates in-flight callbacks. */
  reset: () => void;
};

/** Internal status of the latest tracked mutation. */
type MutationStatus = "idle" | "pending" | "error";

/**
 * A light TanStack-Query-style mutation wrapper for Zero mutations.
 *
 * Tracks a single mutation at a time: `isPending` is `true` while the tracked
 * promise (client or server per `awaitMode`) is in flight, and `error` holds
 * the failure if the mutation rejects or resolves with an error details
 * object.
 *
 * `mutatorGetter` returns a `Mutator` from a mutator registry — a reference,
 * *not* a call — e.g. `() => mutators.addItem`. The composable invokes the
 * getter to obtain the mutator, executes it against the current zero via
 * `zero.mutate(mutator(...args))`, and tracks the result. Because the getter
 * returns the mutator itself, the selected mutator's argument type is
 * inferred onto `mutate`: `mutators.addItem` takes `{id, name}`, so
 * `mutate({id, name})`. The getter is evaluated per `mutate` call and never
 * captures a zero externally — the zero (which may be reactive) is read at
 * call time. The returned `mutate` resolves with the resulting
 * `MutatorResult`:
 *
 * ```ts
 * const { mutate, isPending, error } = useMutator(zero, () => mutators.addItem);
 * mutate({ id: 1, name: "alpha" });
 * ```
 *
 * The bound `useMutator` from `createBindings` injects the shared reactive
 * zero and the mutator registry, so the getter receives the registry
 * directly: `useMutator((mutators) => mutators.addItem)`.
 *
 * The tracked promise races against `options.timeout`
 * (`DEFAULT_MUTATION_TIMEOUT_MS` by default); on timeout `isPending` flips to
 * `false` and `error` becomes a `MutationTimeoutError`, while the underlying
 * `MutatorResult` promises are left to settle on their own.
 *
 * The promise returned by `mutate` is the tracked promise with the call's
 * throw policy applied: with `throwOnTimeout` (default `false`) it rejects
 * with a `MutationTimeoutError` on timeout, and with `throwOnError` (default
 * `true`) it rejects when the mutation resolves with error details — so by
 * default `await mutate(...)` throws when the mutation itself fails. Pass
 * `throwOnError: false` to resolve with the `MutatorResultDetails` (the
 * `error` ref still reports the failure either way).
 *
 * `UseMutatorOptions.onError` observes every failure — timeouts and
 * mutation errors alike — receiving a `{ error, args }` info object: the
 * same branded `Error` that is set on the `error` ref (`instanceof
 * MutationTimeoutError` vs `instanceof MutationError` tells the two apart),
 * plus the mutator's arguments object, without affecting the throw policy.
 * `UseMutatorOptions.onSuccess` fires when the mutation succeeds (with
 * `{ args }`), and `UseMutatorOptions.onSettled` fires on every settle
 * (success or failure) with `{ args, error? }`.
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

  const awaitMode = computed(() => optionsRef.value?.awaitMode ?? "client");
  const timeoutMs = computed(() => optionsRef.value?.timeout ?? DEFAULT_MUTATION_TIMEOUT_MS);
  const throwOnTimeout = computed(() => optionsRef.value?.throwOnTimeout ?? false);
  const throwOnError = computed(() => optionsRef.value?.throwOnError ?? true);

  const _status = ref<MutationStatus>("idle");
  const _error = ref<Error | null>(null);

  // Monotonic counter for the latest mutation. In-flight callbacks for older
  // mutations are ignored, so an earlier promise's settlement can never
  // clobber a newer mutation's state (or `reset`'s idle state).
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

    const id = ++mutationId;
    _status.value = "pending";
    _error.value = null;

    const timeout = timeoutMs.value;
    const throwOnTimeoutCall = throwOnTimeout.value;
    const throwOnErrorCall = throwOnError.value;

    const promise = awaitMode.value === "server" ? result.server : result.client;

    let timerId: number | undefined;
    let tracked: Promise<MutatorResultDetails>;
    if (timeout === Infinity) {
      tracked = promise;
    } else {
      const timer = new Promise<never>((_, reject) => {
        const id = setTimeout(() => reject(new MutationTimeoutError(timeout)), timeout);
        timerId = id;
        pendingTimers.add(id);
      });
      tracked = Promise.race([promise, timer]);
    }

    // Zero mutators are arity-1 (the runtime callable is `(args) => …`), so
    // `args` is a single-element tuple and `args[0]` is the mutator's
    // arguments object — the `variables` surfaced to the callbacks. No tuple
    // is ever exposed.
    const variables = args[0] as TMutator["~"]["$input"];

    // Failure reporting: sets the state refs and notifies the
    // `UseMutatorOptions.onError` and `onSettled` observers (onError is
    // composed by `createBindings` to also fire the bindings-level callback,
    // local first). Observer throws are contained — they must not break the
    // tracking chain or double-fire via the catch handler.
    const report = (error: Error) => {
      _error.value = error;
      _status.value = "error";
      const opts = optionsRef.value;
      const info = { args: variables, mutatorName: mutator.mutatorName };
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

    // Success reporting: `onSuccess` fires first, then `onSettled` (with
    // `error` undefined).
    const succeed = () => {
      const opts = optionsRef.value;
      const info = { args: variables, mutatorName: mutator.mutatorName };
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

    // Attach the tracking chain to `tracked` (never the bare `promise`), so
    // the timeout race is observed and the timer rejection is always handled.
    // The throw policy only shapes the returned promise, not this state
    // tracking. Failures are branded so consumers can tell them apart:
    // `MutationTimeoutError` for timeouts (only the race produces it),
    // `MutationError` for resolved error details, as-is for genuine
    // rejections.
    tracked
      .then((details) => {
        if (disposed || id !== mutationId) return;
        if (details.type === "error") {
          report(new MutationError(details.error.message, { cause: details.error }));
        } else {
          succeed();
        }
      })
      .catch((e: unknown) => {
        if (disposed || id !== mutationId) return;
        report(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        clearTimeout(timerId);
        if (timerId !== undefined) {
          pendingTimers.delete(timerId);
        }
        if (disposed || id !== mutationId) return;
        if (_status.value === "pending") _status.value = "idle";
      });

    // The promise this call returns: the tracked promise with the throw
    // policy applied. Timeout rejects the call only when throwOnTimeout is
    // set; error-details reject only when throwOnError is set. Genuine
    // rejections of the tracked promise always propagate.
    let returned: Promise<MutatorResultDetails>;
    if (throwOnTimeoutCall) {
      returned = tracked.then((details) => {
        if (throwOnErrorCall && details.type === "error") {
          throw new MutationError(details.error.message, { cause: details.error });
        }
        return details;
      });
    } else if (throwOnErrorCall) {
      returned = promise.then((details) => {
        if (details.type === "error") {
          throw new MutationError(details.error.message, { cause: details.error });
        }
        return details;
      });
    } else {
      returned = promise;
    }

    if (awaitMode.value === "server") {
      return { client: result.client, server: returned };
    }
    return { client: returned, server: result.server };
  }

  function reset() {
    mutationId++;
    _status.value = "idle";
    _error.value = null;
  }

  return {
    mutate,
    isPending: computed(() => _status.value === "pending"),
    error: computed(() => _error.value),
    reset,
  };
}
