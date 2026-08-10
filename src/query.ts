import {
  ref,
  shallowRef,
  computed,
  onUnmounted,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  toValue,
  getCurrentInstance,
} from "vue";
import {
  type BaseDefaultContext,
  type BaseDefaultSchema,
  type CustomMutatorDefs,
  type DefaultContext,
  type DefaultSchema,
  type Falsy,
  type HumanReadable,
  type PullRow,
  type QueryOrQueryRequest,
  type ReadonlyJSONValue,
  type TTL,
} from "@rocicorp/zero";
import { addContextToQuery, asQueryInternals, DEFAULT_TTL_MS } from "@rocicorp/zero/bindings";
import { VueView, vueViewFactory, type QueryError, type QueryStatus } from "./vue-view.ts";
import type { Zero } from "@rocicorp/zero";

export type { QueryError, QueryStatus } from "./vue-view.ts";

export type QueryResult<TReturn> = {
  data: ComputedRef<HumanReadable<TReturn>>;
  error: ComputedRef<QueryError | undefined>;
  status: ComputedRef<QueryStatus>;
};

export type MaybeQueryResult<TReturn> = {
  data: ComputedRef<HumanReadable<TReturn> | undefined>;
  error: ComputedRef<QueryError | undefined>;
  status: ComputedRef<QueryStatus>;
};

export type UseQueryOptions = {
  ttl?: TTL | undefined;
};

/**
 * Overload 1: Query — returns QueryResult<TReturn>
 */
export function useQuery<
  TTable extends keyof TSchema["tables"] & string,
  TInput extends ReadonlyJSONValue | undefined,
  TOutput extends ReadonlyJSONValue | undefined,
  TSchema extends BaseDefaultSchema = DefaultSchema,
  TReturn = PullRow<TTable, TSchema>,
  TContext extends BaseDefaultContext = DefaultContext,
  MD extends CustomMutatorDefs | undefined = undefined,
>(
  zeroInput: MaybeRefOrGetter<Zero<TSchema, MD, TContext>>,
  querySignal: () => QueryOrQueryRequest<TTable, TInput, TOutput, TSchema, TReturn, TContext>,
  options?: UseQueryOptions | (() => UseQueryOptions | undefined),
): QueryResult<TReturn>;

/**
 * Overload 2: Maybe query
 */
export function useQuery<
  TTable extends keyof TSchema["tables"] & string,
  TInput extends ReadonlyJSONValue | undefined,
  TOutput extends ReadonlyJSONValue | undefined,
  TSchema extends BaseDefaultSchema = DefaultSchema,
  TReturn = PullRow<TTable, TSchema>,
  TContext extends BaseDefaultContext = DefaultContext,
  MD extends CustomMutatorDefs | undefined = undefined,
>(
  zeroInput: MaybeRefOrGetter<Zero<TSchema, MD, TContext>>,
  querySignal: () =>
    | QueryOrQueryRequest<TTable, TInput, TOutput, TSchema, TReturn, TContext>
    | Falsy,
  options?: UseQueryOptions | (() => UseQueryOptions | undefined),
): MaybeQueryResult<TReturn>;

/**
 * Implementation
 */
export function useQuery<
  TTable extends keyof TSchema["tables"] & string,
  TInput extends ReadonlyJSONValue | undefined,
  TOutput extends ReadonlyJSONValue | undefined,
  TSchema extends BaseDefaultSchema = DefaultSchema,
  TReturn = PullRow<TTable, TSchema>,
  TContext extends BaseDefaultContext = DefaultContext,
  MD extends CustomMutatorDefs | undefined = undefined,
>(
  z: MaybeRefOrGetter<Zero<TSchema, MD, TContext>>,
  querySignal: () =>
    | QueryOrQueryRequest<TTable, TInput, TOutput, TSchema, TReturn, TContext>
    | Falsy,
  options?: UseQueryOptions | (() => UseQueryOptions | undefined),
): QueryResult<TReturn> | MaybeQueryResult<TReturn> {
  const zero = computed(() => toValue(z));
  const optionsRef = computed(() => toValue(options));

  const ttl = computed(() => optionsRef.value?.ttl ?? DEFAULT_TTL_MS);

  const refetchKey = ref(0);

  const retry = () => {
    refetchKey.value++;
  };

  const resolvedQuery = computed(() => {
    const raw = querySignal();
    if (!raw) return undefined;
    return addContextToQuery(raw, zero.value.context);
  });

  const hash = computed(() => {
    const q = resolvedQuery.value;
    if (!q) return undefined;
    try {
      const qi = asQueryInternals(q);
      return qi.hash() + JSON.stringify(qi.format ?? null) + zero.value.clientID;
    } catch {
      return undefined;
    }
  });

  // Hold the materialized view (a VueView produced by zero.materialize's view
  // factory) as a single ref, and derive read-only data/status/error from it.
  // `null` means the query is disabled (falsy signal) → status 'disabled'.
  const view = shallowRef<VueView<TReturn> | null>(null);

  watch(
    [zero, hash, refetchKey],
    ([currentZero]) => {
      view.value?.destroy();
      view.value = null;

      const q = resolvedQuery.value;
      if (!q || hash.value === undefined) {
        return;
      }

      view.value = currentZero.materialize(q, vueViewFactory, { ttl: ttl.value });
    },
    { immediate: true },
  );

  // Watch TTL changes
  watch(ttl, (newTTL) => {
    view.value?.updateTTL(newTTL);
  });

  // Cleanup on unmount
  if (getCurrentInstance()) {
    onUnmounted(() => {
      view.value?.destroy();
    });
  }

  return {
    data: computed(() => view.value?.data.value as HumanReadable<TReturn>),
    status: computed(() => view.value?.status.value ?? "disabled"),
    error: computed(() => {
      const err = view.value?.error.value;
      return err ? { retry, ...err } : undefined;
    }),
  };
}
