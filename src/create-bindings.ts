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
  QueryOrQueryRequest,
  ReadonlyJSONValue,
  Zero,
} from "@rocicorp/zero";

/**
 * Creates a set of zero-bound composables for a given Zero instance.
 *
 * Call once per app with your `zero` (a plain `Zero`, `shallowRef`, or getter —
 * any `MaybeRefOrGetter`). The returned `query` is `useQuery` with the zero
 * pre-bound, so the zero is passed once instead of on every call.
 *
 * All returned composables share the same reactive zero, so when a reactive
 * zero is replaced every bound view tears down and re-materializes against the
 * new instance.
 */
export function createBindings<
  S extends BaseDefaultSchema = DefaultSchema,
  Context extends BaseDefaultContext = DefaultContext,
>(zero: MaybeRefOrGetter<Zero<S, undefined, Context>>) {
  const sharedZero = computed(() => toValue(zero));

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
    querySignal: () => QueryOrQueryRequest<TTable, TInput, TOutput, S, TReturn, Context> | Falsy,
    options?: UseQueryOptions | (() => UseQueryOptions | undefined),
  ): QueryResult<TReturn> | MaybeQueryResult<TReturn> {
    return useQuery(sharedZero, querySignal, options);
  }

  return { query };
}
