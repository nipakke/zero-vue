import {
  computed,
  getCurrentInstance,
  onUnmounted,
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
  readonly name = "MutationTimeoutError";
  constructor(ms: number) {
    super(`Mutation timed out after ${ms}ms`);
  }
}

/**
 * Options for one `mutate` call. Passed as the trailing argument to `mutate`;
 * local values override the composable-level `UseMutationOptions` for that
 * call only. (Caveat: a final argument object that has any of these keys is
 * treated as call options, so mutation payloads carrying a `timeout`,
 * `throwOnTimeout`, or `throwOnError` field cannot be passed last.)
 */
export type MutationCallOptions = {
  /** Max ms to wait for the tracked promise on this call; overrides `UseMutationOptions.timeout`. */
  timeout?: number;
  /** Reject this call's tracked promise when it exceeds `timeout`. */
  throwOnTimeout?: boolean;
  /** Reject this call's tracked promise when the mutation resolves with an error details object. */
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
   * resolves with an error details object (`{type: 'error', ...}`). Default:
   * `false` (the error is reported via the `error` ref, and the call resolves
   * with the error details). Genuine promise rejections always reject
   * regardless of this flag. Overridable per call via
   * `MutationCallOptions.throwOnError`.
   */
  throwOnError?: boolean;
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

function isMutationCallOptions(value: unknown): value is MutationCallOptions {
  if (typeof value !== "object" || value === null) return false;
  return ["timeout", "throwOnTimeout", "throwOnError"].some((key) => key in value);
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
 * throw policy applied: with `throwOnTimeout` it rejects with a
 * `MutationTimeoutError` on timeout, and with `throwOnError` it rejects when
 * the mutation resolves with error details. Both default to `false`, so by
 * default the returned promise behaves like Zero's own tracked promise
 * (resolves with the `MutatorResultDetails`). Options can be set globally on
 * `useMutation` or per call as the trailing `mutate` argument — per-call
 * values win.
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
  const throwOnError = computed(() => optionsRef.value?.throwOnError ?? false);

  const _status = ref<MutationStatus>("idle");
  const _error = ref<Error | null>(null);

  // Monotonic counter for the latest mutation. In-flight callbacks for older
  // mutations are ignored, so an earlier promise's settlement can never
  // clobber a newer mutation's state (or `reset`'s idle state).
  let mutationId = 0;

  let disposed = false;
  if (getCurrentInstance()) {
    onUnmounted(() => {
      disposed = true;
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
        timerId = setTimeout(() => reject(new MutationTimeoutError(timeout)), timeout);
      });
      tracked = Promise.race([promise, timer]);
    }

    // Attach the tracking chain to `tracked` (never the bare `promise`), so
    // the timeout race is observed and the timer rejection is always handled.
    // The throw policy only shapes the returned promise, not this state
    // tracking.
    tracked
      .then((details) => {
        if (disposed || id !== mutationId) return;
        if (details.type === "error") {
          _error.value = new Error(details.error.message);
          _status.value = "error";
        }
      })
      .catch((e: unknown) => {
        if (disposed || id !== mutationId) return;
        _error.value = e instanceof Error ? e : new Error(String(e));
        _status.value = "error";
      })
      .finally(() => {
        clearTimeout(timerId);
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
          throw new Error(details.error.message);
        }
        return details;
      });
    } else if (throwOnErrorCall) {
      returned = promise.then((details) => {
        if (details.type === "error") {
          throw new Error(details.error.message);
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
