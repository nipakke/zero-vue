import { computed, toValue, type ComputedRef, type MaybeRefOrGetter, type Ref } from "vue";
import {
  useQuery,
  type QueryResult,
  type MaybeQueryResult,
  type UseQueryOptions,
} from "./query.ts";
import { useMutation, type MutationResult, type UseMutationOptions } from "./mutation.ts";
import { useConnectionState } from "./connection-state.ts";
import type {
  BaseDefaultContext,
  BaseDefaultSchema,
  ConnectionState,
  CustomMutatorDefs,
  DefaultContext,
  DefaultSchema,
  Falsy,
  MutatorDefinitions,
  MutateRequest,
  MutatorRegistry,
  PullRow,
  QueryDefinitions,
  QueryOrQueryRequest,
  QueryRegistry,
  ReadonlyJSONValue,
  Zero,
} from "@rocicorp/zero";

/**
 * The queries argument to the returned `query` composable. Resolves to
 * `never` when `createBindings` was called without a query registry, so the
 * queries-taking form is only available when one was provided.
 *
 * The registry is presented to the callback with the concrete schema `S` so
 * that `q.all()` yields a query typed against the bound zero. (The registry's
 * own schema is a phantom: `defineQuery` widens it to `Schema`, but it has no
 * runtime effect — the query runs against the bound zero.)
 */
type BoundQueries<QD extends QueryDefinitions, S extends BaseDefaultSchema> = [QD] extends [never]
  ? never
  : QueryRegistry<QD, S>;

/**
 * The mutators argument to the returned `useMutation` callback. Resolves to
 * `never` when `createBindings` was called without a mutator registry, so the
 * mutators-taking form is only available when one was provided.
 */
type BoundMutators<MRD extends MutatorDefinitions, S extends BaseDefaultSchema> = [MRD] extends [
  never,
]
  ? never
  : MutatorRegistry<MRD, S>;

/** Context injected into a bound `useMutation` callback — the bound mutator
 * registry. The callback returns a `MutateRequest` from this registry, which
 * the core composable executes against the shared zero. */
type BoundMutationContext<MRD extends MutatorDefinitions, S extends BaseDefaultSchema> = {
  readonly mutators: BoundMutators<MRD, S>;
};

/**
 * Creates a set of zero-bound composables for a given Zero instance.
 *
 * Call once per app with your `zero` (a plain `Zero`, `shallowRef`, or getter —
 * any `MaybeRefOrGetter`). The returned `useQuery` is the `useQuery` composable
 * with the zero pre-bound, so the zero is passed once instead of on every call.
 *
 * Optionally pass a `{ queries }` options object (the `queries` registry comes
 * from `defineQueries`) as the second argument. When provided, the returned
 * `useQuery` also accepts a getter that receives that registry:
 *
 * ```ts
 * const { useQuery } = createBindings(zero, { queries });
 * useQuery((q) => q.allItems());
 * ```
 *
 * When no registry is given, `useQuery` only takes the zero-argument getter form.
 *
 * The returned `useMutation` wraps the core `useMutation` with the shared zero
 * pre-bound. Pass a `{ mutators }` registry (from `defineMutators`) to inject
 * it into the mutation callback; the callback returns a `MutateRequest` from
 * that registry and the composable executes it against the shared zero:
 *
 * ```ts
 * const { useMutation } = createBindings(zero, { mutators });
 * const { mutate } = useMutation(({ mutators }, item) =>
 *   mutators.addItem(item),
 * );
 * ```
 *
 * The mutators registry must be the same one passed to the `Zero` constructor
 * (`new Zero({mutators, …})`) — Zero executes the mutators it was constructed
 * with, and the bindings registry only supplies the typed callback surface.
 *
 * Without a mutator registry the callback's context carries `mutators: never`;
 * return a `MutateRequest` from a registry you hold yourself:
 *
 * ```ts
 * const { useMutation } = createBindings(zero);
 * const { mutate } = useMutation((_, item) => myMutators.addItem(item));
 * ```
 *
 * The returned `useConnectionState` is the {@link useConnectionState}
 * composable pre-bound to the shared zero (call with no arguments). The
 * returned `useZero` exposes the shared reactive zero itself as a read-only
 * `ComputedRef`, so components can read the current instance directly:
 *
 * ```ts
 * const { useConnectionState, useZero } = createBindings(zero);
 * const state = useConnectionState(); // Ref<ConnectionState>
 * const z = useZero(); // ComputedRef<Zero>
 * ```
 *
 * All returned composables share the same reactive zero, so when a reactive
 * zero is replaced every bound view tears down and re-materializes against the
 * new instance.
 */
export function createBindings<
  S extends BaseDefaultSchema = DefaultSchema,
  Context extends BaseDefaultContext = DefaultContext,
  MD extends CustomMutatorDefs | undefined = undefined,
  const QD extends QueryDefinitions = never,
  const MRD extends MutatorDefinitions = never,
>(
  zero: MaybeRefOrGetter<Zero<S, MD, Context>>,
  bindings?: {
    queries?: QueryRegistry<QD, BaseDefaultSchema>;
    mutators?: MutatorRegistry<MRD, S>;
    /**
     * App-level mutation error observer, fired for every bound mutation's
     * failure — good for analytics, logging, and telemetry. Receives the same
     * branded `Error` as `UseMutationOptions.onMutationError` and the
     * composable's `error` ref: `instanceof MutationTimeoutError` for
     * timeouts, `instanceof MutationError` for mutation failures. Fires after
     * the per-composable callback, if any; like the local one it is a pure
     * observer and never changes what `mutate` returns or what `error` holds.
     */
    onMutationError?: (error: Error) => void;
  },
) {
  const sharedZero = computed(() => toValue(zero));

  // Queries-taking overload: `query((queries) => …)`. Only usable when a
  // registry was provided; otherwise `queries` is `never` and the callback
  // cannot access anything on it.
  function query<
    TTable extends keyof S["tables"] & string,
    TInput extends ReadonlyJSONValue | undefined,
    TOutput extends ReadonlyJSONValue | undefined,
    TReturn = PullRow<TTable, S>,
  >(
    querySignal: (
      queries: BoundQueries<QD, S>,
    ) => QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, Context>,
    options?: UseQueryOptions | (() => UseQueryOptions | undefined),
  ): QueryResult<TReturn>;

  function query<
    TTable extends keyof S["tables"] & string,
    TInput extends ReadonlyJSONValue | undefined,
    TOutput extends ReadonlyJSONValue | undefined,
    TReturn = PullRow<TTable, S>,
  >(
    querySignal: (
      queries: BoundQueries<QD, S>,
    ) => QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, Context> | Falsy,
    options?: UseQueryOptions | (() => UseQueryOptions | undefined),
  ): MaybeQueryResult<TReturn>;

  // Existing overloads: `query(() => …)`.
  function query<
    TTable extends keyof S["tables"] & string,
    TInput extends ReadonlyJSONValue | undefined,
    TOutput extends ReadonlyJSONValue | undefined,
    TReturn = PullRow<TTable, S>,
  >(
    querySignal: () => QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, Context>,
    options?: UseQueryOptions | (() => UseQueryOptions | undefined),
  ): QueryResult<TReturn>;

  function query<
    TTable extends keyof S["tables"] & string,
    TInput extends ReadonlyJSONValue | undefined,
    TOutput extends ReadonlyJSONValue | undefined,
    TReturn = PullRow<TTable, S>,
  >(
    querySignal: () => QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, Context> | Falsy,
    options?: UseQueryOptions | (() => UseQueryOptions | undefined),
  ): MaybeQueryResult<TReturn>;

  function query<
    TTable extends keyof S["tables"] & string,
    TInput extends ReadonlyJSONValue | undefined,
    TOutput extends ReadonlyJSONValue | undefined,
    TReturn = PullRow<TTable, S>,
  >(
    querySignal: (
      queries: BoundQueries<QD, S>,
    ) => QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, Context> | Falsy,
    options?: UseQueryOptions | (() => UseQueryOptions | undefined),
  ): QueryResult<TReturn> | MaybeQueryResult<TReturn> {
    // A zero-argument signal ignores the passed registry, so one call serves
    // both the `() => query` and `(queries) => query` forms.
    return useQuery(
      sharedZero,
      () => querySignal(bindings?.queries as BoundQueries<QD, S>),
      options,
    );
  }

  // The bound useMutation: wraps the core composable with the shared zero and
  // injects the optional mutator registry into the callback context. The
  // bindings-level `onMutationError` (if any) is composed into the options so
  // both observers fire per failure — the local one first, then the global.
  function mutation<const TArgs extends unknown[] = []>(
    mutationFn: (
      ctx: BoundMutationContext<MRD, S>,
      ...args: TArgs
    ) => MutateRequest<any, S, Context, any>,
    options?: UseMutationOptions | (() => UseMutationOptions | undefined),
  ): MutationResult<TArgs> {
    // Compose the bindings-level observer with any per-composable one: the
    // composed `onMutationError` is always present in the bound options and
    // just optionally invokes the local and/or global callbacks.
    const mergedOptions = (): UseMutationOptions | undefined => {
      const local = toValue(options);
      const localOnError = local?.onMutationError;
      const globalOnError = bindings?.onMutationError;
      return {
        ...local,
        onMutationError: (error) => {
          localOnError?.(error);
          globalOnError?.(error);
        },
      };
    };
    return useMutation(
      sharedZero,
      (...args) =>
        mutationFn(
          {
            mutators: bindings?.mutators as BoundMutators<MRD, S>,
          },
          ...args,
        ),
      mergedOptions,
    );
  }

  // The bound useConnectionState: tracks the shared zero's connection state,
  // re-subscribing when the (possibly reactive) zero is swapped.
  function connectionState(): Ref<ConnectionState> {
    return useConnectionState(sharedZero);
  }

  // The shared reactive zero itself, for direct access in components.
  function currentZero(): ComputedRef<Zero<S, MD, Context>> {
    return sharedZero;
  }

  return {
    useQuery: query,
    useMutation: mutation,
    useConnectionState: connectionState,
    useZero: currentZero,
  };
}
