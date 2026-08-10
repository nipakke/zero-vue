import { computed, toValue, type MaybeRefOrGetter } from "vue";
import {
  useQuery,
  type QueryResult,
  type MaybeQueryResult,
  type UseQueryOptions,
} from "./query.ts";
import type {
  BaseDefaultContext,
  BaseDefaultSchema,
  DefaultContext,
  DefaultSchema,
  Falsy,
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
type BoundQueries<QD extends QueryDefinitions, S extends BaseDefaultSchema> =
  [QD] extends [never] ? never : QueryRegistry<QD, S>;

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
 * All returned composables share the same reactive zero, so when a reactive
 * zero is replaced every bound view tears down and re-materializes against the
 * new instance.
 */
export function createBindings<
  S extends BaseDefaultSchema = DefaultSchema,
  Context extends BaseDefaultContext = DefaultContext,
  const QD extends QueryDefinitions = never,
>(
  zero: MaybeRefOrGetter<Zero<S, undefined, Context>>,
  bindings?: { queries?: QueryRegistry<QD, BaseDefaultSchema> },
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
    querySignal: () =>
      | QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, Context>
      | Falsy,
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
    ) =>
      | QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, Context>
      | Falsy,
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

  return { useQuery: query };
}
