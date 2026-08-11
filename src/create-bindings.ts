import { computed, toValue, type ComputedRef, type MaybeRefOrGetter, type Ref } from "vue";
import {
  useQuery,
  type QueryResult,
  type MaybeQueryResult,
  type UseQueryOptions,
} from "./query.ts";
import {
  useMutator,
  type MutationKind,
  type MutationResult,
  type UseMutatorOptions,
  type ZeroMutator,
} from "./mutation.ts";
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
 * The mutators argument to the returned `useMutator` getter. Resolves to
 * `never` when `createBindings` was called without a mutator registry, so the
 * registry-taking form is only available when one was provided.
 */
type BoundMutators<MRD extends MutatorDefinitions, S extends BaseDefaultSchema> = [MRD] extends [
  never,
]
  ? never
  : MutatorRegistry<MRD, S>;

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
 * The returned `useMutator` wraps the core `useMutator` with the shared zero
 * pre-bound. Pass a `{ mutators }` registry (from `defineMutators`) to inject
 * it into the mutator getter; the getter receives that registry and returns a
 * `Mutator` (a reference, not a call), and the composable executes it against
 * the shared zero. The selected mutator's argument type is inferred onto
 * `mutate`:
 *
 * ```ts
 * const { useMutator } = createBindings(zero, { mutators });
 * const { mutate } = useMutator((mutators) => mutators.addItem);
 * mutate({ id: 1, name: "alpha" });
 * ```
 *
 * The mutators registry must be the same one passed to the `Zero` constructor
 * (`new Zero({mutators, …})`) — Zero executes the mutators it was constructed
 * with, and the bindings registry only supplies the typed callback surface.
 *
 * Without a mutator registry the getter's parameter is `never`; return a
 * `Mutator` from a registry you hold yourself:
 *
 * ```ts
 * const { useMutator } = createBindings(zero);
 * const { mutate } = useMutator(() => myMutators.addItem);
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
     * failure — good for analytics, logging, and telemetry. Same shape and
     * semantics as the per-composable `UseMutatorOptions.onError`: receives a
     * `{ error, args, mutatorName }` info object (the same branded `Error`
     * set on the composable's `error` ref — `instanceof MutationTimeoutError`
     * for timeouts, `instanceof MutationError` for mutation failures — plus
     * the mutator's arguments, typed `unknown` here because different bound
     * mutators have different arg types, and the mutator's name). Fires after
     * the per-composable callback, if any; like the local one it is a pure
     * observer and never changes what `mutate` returns or what `error` holds.
     */
    onMutationError?: (info: {
      error: Error;
      args: unknown;
      mutatorName: string;
      kind: MutationKind;
    }) => void;
    /**
     * App-level success observer, fired for every bound mutation that
     * succeeds. Same shape and semantics as the per-composable
     * `UseMutatorOptions.onSuccess`: receives `{ args, mutatorName }` (the
     * mutator's arguments, typed `unknown` because different bound mutators
     * have different arg types). Fires after the per-composable `onSuccess`,
     * if any.
     */
    onMutationSuccess?: (info: { args: unknown; mutatorName: string; kind: MutationKind }) => void;
    /**
     * App-level settle observer, fired for every bound mutation that settles
     * (success or failure). Same shape and semantics as the per-composable
     * `UseMutatorOptions.onSettled`: receives `{ args, error?, mutatorName }`,
     * with `error` set on failure/timeout and `undefined` on success. Fires
     * after the per-composable `onSettled`, if any.
     */
    onMutationSettled?: (info: {
      args: unknown;
      error?: Error;
      mutatorName: string;
      kind: MutationKind;
    }) => void;
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

  // The bound useMutator: wraps the core composable with the shared zero and
  // injects the optional mutator registry into the getter, which returns a
  // `Mutator` reference (not a call) so the selected mutator's argument type
  // is inferred onto `mutate`. The bindings-level `onMutationError`/
  // `onMutationSuccess`/`onMutationSettled` (if any) are composed into the
  // options so both observers fire per failure/settle — the local one first,
  // then the global.
  function mutator<TMutator extends ZeroMutator = ZeroMutator>(
    mutatorGetter: (mutators: BoundMutators<MRD, S>) => TMutator,
    options?:
      | UseMutatorOptions<TMutator["~"]["$input"]>
      | (() => UseMutatorOptions<TMutator["~"]["$input"]> | undefined),
  ): MutationResult<Parameters<TMutator>> {
    // Compose the bindings-level observers with any per-composable ones: the
    // composed `onError`, `onSuccess`, and `onSettled` are always present in
    // the bound options and just optionally invoke the local and/or global
    // callbacks (local first, then global).
    const mergedOptions = (): UseMutatorOptions<TMutator["~"]["$input"]> | undefined => {
      const local = toValue(options);
      const localOnError = local?.onError;
      const globalOnError = bindings?.onMutationError;
      const localOnSuccess = local?.onSuccess;
      const globalOnSuccess = bindings?.onMutationSuccess;
      const localOnSettled = local?.onSettled;
      const globalOnSettled = bindings?.onMutationSettled;
      return {
        ...local,
        onError: (info) => {
          localOnError?.(info);
          globalOnError?.(info);
        },
        onSuccess: (info) => {
          localOnSuccess?.(info);
          globalOnSuccess?.(info);
        },
        onSettled: (info) => {
          localOnSettled?.(info);
          globalOnSettled?.(info);
        },
      };
    };
    return useMutator(
      sharedZero,
      () => mutatorGetter(bindings?.mutators as BoundMutators<MRD, S>),
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
    useMutator: mutator,
    useConnectionState: connectionState,
    useZero: currentZero,
  };
}
