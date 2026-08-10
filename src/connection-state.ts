import {
  computed,
  onUnmounted,
  ref,
  watch,
  type MaybeRefOrGetter,
  type Ref,
  toValue,
} from "vue";
import type {
  BaseDefaultContext,
  BaseDefaultSchema,
  ConnectionState,
  CustomMutatorDefs,
  DefaultContext,
  DefaultSchema,
  Zero,
} from "@rocicorp/zero";

/**
 * Tracks the connection status of a Zero instance.
 *
 * Resolves the zero reactively — if the caller passes a `ref`/getter that later
 * changes to a different Zero instance, the old subscription is torn down and a
 * new one is created against the new instance.
 *
 * @param zero The Zero instance (or a ref/getter resolving to one).
 * @returns A ref containing the current {@link ConnectionState}.
 * @see {@link ConnectionState} for more details on the connection state.
 */
export function useConnectionState<
  S extends BaseDefaultSchema = DefaultSchema,
  Context extends BaseDefaultContext = DefaultContext,
  MD extends CustomMutatorDefs | undefined = undefined,
>(zero: MaybeRefOrGetter<Zero<S, MD, Context>>): Ref<ConnectionState> {
  const zeroRef = computed(() => toValue(zero));
  const connectionState = ref<ConnectionState>(zeroRef.value.connection.state.current);

  let unsubscribe: (() => void) | undefined;

  const subscribe = (z: Zero<S, MD, Context>) => {
    connectionState.value = z.connection.state.current;
    unsubscribe = z.connection.state.subscribe((state: ConnectionState) => {
      connectionState.value = state;
    });
  };

  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  watch(
    zeroRef,
    (newZero, _oldZero, onCleanup) => {
      cleanup();
      subscribe(newZero);
      onCleanup(cleanup);
    },
    { immediate: true },
  );

  onUnmounted(cleanup);

  return connectionState;
}
