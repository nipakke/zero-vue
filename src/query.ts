import {
  ref,
  shallowRef,
  computed,
  getCurrentScope,
  onScopeDispose,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  toValue,
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
 * Outcome of hashing the resolved query. `undefined` when the query is
 * disabled (falsy signal); `{ok: false}` when the query exists but cannot be
 * hashed (e.g. built against a different copy of Zero) — surfaced as
 * `status: 'error'` rather than a silent `'disabled'`.
 */
type QueryHash = { ok: true; value: string } | { ok: false; error: Error };

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

  const hash = computed<QueryHash | undefined>(() => {
    const q = resolvedQuery.value;
    if (!q) return undefined;
    try {
      const qi = asQueryInternals(q);
      return {
        ok: true,
        value: qi.hash() + JSON.stringify(qi.format ?? null) + zero.value.clientID,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
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
      if (!q || hash.value === undefined || !hash.value.ok) {
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

  // Cleanup when the enclosing scope (component or effectScope) is disposed
  if (getCurrentScope()) {
    onScopeDispose(() => {
      view.value?.destroy();
    });
  }

  return {
    data: computed(() => view.value?.data.value as HumanReadable<TReturn>),
    status: computed(() => {
      if (hash.value?.ok === false) return "error";
      return view.value?.status.value ?? "disabled";
    }),
    error: computed(() => {
      const hashFailure = hash.value;
      if (hashFailure?.ok === false) {
        return { type: "InvalidQuery", message: hashFailure.error.message, retry };
      }
      const err = view.value?.error.value;
      return err ? { retry, ...err } : undefined;
    }),
  };
}
