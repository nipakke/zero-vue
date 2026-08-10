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
  MutatorResult,
  MutatorResultDetails,
  Zero,
} from "@rocicorp/zero";

/** Default `UseMutationOptions.timeout` / `MutationCallOptions.timeout` — 5 seconds. */
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

/**
 * Options for one `mutate` call. Passed as the trailing argument to `mutate`;
 * local values override the composable-level `UseMutationOptions` for that
 * call only.
 *
 * Detection rule: the final argument is treated as call options only when it
 * is a plain object whose keys are a subset of `timeout`, `throwOnTimeout`,
 * and `throwOnError` AND whose values match the expected types (number for
 * `timeout`, boolean for the flags). A payload that carries any other field,
 * or these names with different value types, is always passed through to the
 * mutation untouched. The one remaining ambiguity is a payload that consists
 * *exactly* of option keys with matching types (e.g. `{timeout: 5000}`) — it
 * is indistinguishable from options and is treated as options.
 */
export type MutationCallOptions = {
  /** Max ms to wait for the tracked promise on this call; overrides `UseMutationOptions.timeout`. */
  timeout?: number;
  /** Reject this call's tracked promise when it exceeds `timeout`. */
  throwOnTimeout?: boolean;
  /** Reject this call's tracked promise when the mutation resolves with an error details object (default `true`). */
  throwOnError?: boolean;
};

/** Options for `useMutation`. */
export type UseMutationOptions = {
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
   * `Infinity` to disable the timeout entirely. Overridable per call via
   * `MutationCallOptions.timeout`.
   */
  timeout?: number;
  /**
   * Whether the promise returned by `mutate` should reject with a
   * `MutationTimeoutError` when the tracked promise exceeds `timeout`.
   * Default: `false` (the composable's `error` ref still reports it, but the
   * call itself resolves/waits for the real promise). Overridable per call
   * via `MutationCallOptions.throwOnTimeout`.
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
   * Overridable per call via `MutationCallOptions.throwOnError`.
   */
  throwOnError?: boolean;
  /**
   * Observer called whenever a mutation fails — either the tracked promise
   * timed out or the mutation itself failed. Receives the same branded
   * `Error` that is set as the composable's `error` ref at that moment:
   * `instanceof MutationTimeoutError` when the tracked promise exceeded
   * `timeout`, `instanceof MutationError` when the mutation itself failed
   * (genuine rejections pass through as-is). Fires regardless of
   * `throwOnTimeout`/`throwOnError` — it is a pure observer and does not
   * change what `mutate` returns or what `error` holds. Typical uses:
   * analytics, toasts, logging. When the composable comes from
   * `createBindings`, the bindings-level `onMutationError` fires too, after
   * this one.
   */
  onMutationError?: (error: Error) => void;
};

/** Return shape of `useMutation`. */
export type MutationResult<TArgs extends unknown[]> = {
  /** Execute the mutation. The final argument may be `MutationCallOptions`; local values override global options. */
  mutate: (...args: [...TArgs, options?: MutationCallOptions]) => MutatorResult;
  /** `true` while the tracked promise (client or server per `awaitMode`) is in flight. */
  isPending: ComputedRef<boolean>;
  /** `Error` if the mutation failed, `null` otherwise. Read-only computed. */
  error: ComputedRef<Error | null>;
  /** Reset to idle state: clears `error`, sets `isPending` false, invalidates in-flight callbacks. */
  reset: () => void;
};

/** Internal status of the latest tracked mutation. */
type MutationStatus = "idle" | "pending" | "error";

/** The only keys a `MutationCallOptions` object may carry. */
const MUTATION_CALL_OPTION_KEYS = new Set(["timeout", "throwOnTimeout", "throwOnError"]);

/**
 * Decides whether the trailing `mutate` argument is call options or part of
 * the mutation payload. Strict on purpose: an object counts as options only
 * when every key is a known option key AND the values match the option types
 * (number for `timeout`, boolean for the flags). Anything else — extra
 * fields, wrong value types, empty objects — is a payload and passes through.
 */
function isMutationCallOptions(value: unknown): value is MutationCallOptions {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => MUTATION_CALL_OPTION_KEYS.has(key))) {
    return false;
  }
  const options = value as Record<string, unknown>;
  if ("timeout" in options && typeof options.timeout !== "number") return false;
  if ("throwOnTimeout" in options && typeof options.throwOnTimeout !== "boolean") return false;
  if ("throwOnError" in options && typeof options.throwOnError !== "boolean") return false;
  return true;
}

/**
 * A light TanStack-Query-style mutation wrapper for Zero mutations.
 *
 * Tracks a single mutation at a time: `isPending` is `true` while the tracked
 * promise (client or server per `awaitMode`) is in flight, and `error` holds
 * the failure if the mutation rejects or resolves with an error details
 * object.
 *
 * `mutationFn` returns a `MutateRequest` built from a mutator registry (e.g.
 * `mutators.addItem(item)`); the composable executes it against the current
 * zero via `zero.mutate(request)`, so the callback never captures a zero
 * externally — the zero (which may be reactive) is read at call time. The
 * returned `mutate` resolves with the resulting `MutatorResult`:
 *
 * ```ts
 * const { mutate, isPending, error } = useMutation(zero, (item) =>
 *   mutators.addItem(item),
 * );
 * ```
 *
 * The bound `useMutation` from `createBindings` injects the shared reactive
 * zero (and optionally the mutator registry) the same way.
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
 * `error` ref still reports the failure either way). Options can be set
 * globally on `useMutation` or per call as the trailing `mutate` argument —
 * per-call values win.
 *
 * `UseMutationOptions.onMutationError` observes every failure — timeouts and
 * mutation errors alike — receiving the same branded `Error` that is set on
 * the `error` ref (`instanceof MutationTimeoutError` vs `instanceof
 * MutationError` tells the two apart), without affecting the throw policy.
 */
export function useMutation<
  S extends BaseDefaultSchema = DefaultSchema,
  MD extends CustomMutatorDefs | undefined = undefined,
  C extends BaseDefaultContext = DefaultContext,
  const TArgs extends unknown[] = [],
>(
  zeroInput: MaybeRefOrGetter<Zero<S, MD, C>>,
  mutationFn: (...args: TArgs) => MutateRequest<any, S, C, any>,
  options?: UseMutationOptions | (() => UseMutationOptions | undefined),
): MutationResult<TArgs> {
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

  function mutate(...args: [...TArgs, options?: MutationCallOptions]): MutatorResult {
    // A trailing MutationCallOptions object is split off; local values
    // override the composable-level options for this call.
    const last = args.length > 0 ? args[args.length - 1] : undefined;
    const callOptions = isMutationCallOptions(last)
      ? (args.pop() as MutationCallOptions)
      : undefined;

    // Invoke the user's fn first: a synchronous throw (e.g. a falsy zero)
    // propagates to the caller before any state is touched. The returned
    // `MutateRequest` is executed against the current zero, read at call time
    // so a reactive zero swap is honored. (TS cannot narrow a variadic tuple
    // to its prefix, hence the cast.)
    const result = zero.value.mutate(mutationFn(...(args as unknown as TArgs)));

    const id = ++mutationId;
    _status.value = "pending";
    _error.value = null;

    const timeout = callOptions?.timeout ?? timeoutMs.value;
    const throwOnTimeoutCall = callOptions?.throwOnTimeout ?? throwOnTimeout.value;
    const throwOnErrorCall = callOptions?.throwOnError ?? throwOnError.value;

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

    // Failure reporting: sets the state refs and notifies the
    // `UseMutationOptions.onMutationError` observer (composed by
    // `createBindings` to also fire the bindings-level callback, local
    // first). Observer throws are contained — they must not break the
    // tracking chain or double-fire via the catch handler.
    const report = (error: Error) => {
      _error.value = error;
      _status.value = "error";
      const callback = optionsRef.value?.onMutationError;
      if (callback) {
        try {
          callback(error);
        } catch (e) {
          console.error("onMutationError callback threw", e);
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
